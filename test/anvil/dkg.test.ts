import { Contract, parseUnits, type InterfaceAbi } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import {
  DkgDisabledError,
  ProcessCreateError,
  ProcessKeyRevealError,
  ProcessResultError,
} from '../../src/contracts/errors';
import { TxStatus } from '../../src/contracts/SmartContractService';
import { KeyMode } from '../../src/contracts/types';
import { BJJ_SUBGROUP_ORDER, bjjAdd, bjjMulBase, type BjjPoint } from '../../src/crypto/babyjubjub';
import { pointFromReducedTE, pointToReducedTE } from '../../src/crypto/dkg';
import {
  ANVIL_GRACE,
  addresses,
  anvil,
  collect,
  connect,
  devWallet,
  election,
  mine,
  mineAt,
  nextEvent,
  startNode,
  streamError,
  withoutAutomine,
  type MockNode,
} from './harness';

const ACCOUNT = 8;
const DKG_OPERATOR = 19;

// Pool keys as the DKG keeps them (reduced TE), and their secrets.
function poolKeys(n: number): { secrets: bigint[]; keys: [bigint, bigint][] } {
  const secrets = Array.from(
    { length: n },
    (_, i) => 1_000_003n * BigInt(i + 1) + BigInt(Date.now())
  );
  const keys = secrets.map((s): [bigint, bigint] => {
    const p = pointToReducedTE(bjjMulBase(s));
    return [p.x, p.y];
  });
  return { secrets, keys };
}

describe('DKG key modes (davinci-contracts MockDKG)', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let dkg: Contract;
  let census: OffchainCensus;
  // Every pool key the tests handed the mock DKG, by epoch.
  const pools = new Map<string, [bigint, bigint][]>();

  // A Live epoch with `n` pool keys, from a fee-paying operator account.
  async function newEpoch(
    n: number,
    overrides: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasLimit?: bigint } = {}
  ) {
    const { keys } = poolKeys(n);
    const tx = (await dkg.getFunction('newEpoch').send(true, keys, overrides)) as {
      wait: () => Promise<unknown>;
    };
    return { keys, tx };
  }

  async function registrationEpoch(): Promise<string> {
    const epoch = await sdk.registry.getRegistrationEpoch();
    if (!pools.has(epoch)) throw new Error(`unknown epoch ${epoch}`);
    return epoch;
  }

  // A read of the mock DKG that answers an integer.
  async function dkgInt(method: string, ...args: unknown[]): Promise<bigint> {
    return BigInt((await dkg.getFunction(method).staticCall(...args)) as bigint);
  }

  // The key the next application of `epoch` gets.
  async function nextPoolKey(epoch: string): Promise<BjjPoint> {
    const next = Number(await dkgInt('getPoolStatus', epoch));
    const [x, y] = (pools.get(epoch) ?? [])[next];
    return pointFromReducedTE(x, y);
  }

  async function epochIdOf(nonce: bigint): Promise<string> {
    const prefix = await dkgInt('EPOCH_PREFIX');
    return `0x${((prefix << 64n) | nonce).toString(16).padStart(24, '0')}`;
  }

  async function openEpoch(n: number): Promise<string> {
    const { keys, tx } = await newEpoch(n);
    await tx.wait();
    const epoch = await epochIdOf(await dkgInt('epochNonce'));
    pools.set(epoch, keys);
    return epoch;
  }

  beforeAll(async () => {
    node = await startNode('dkg');
    sdk = await connect(ACCOUNT, node, { registry: 'dkg' });
    dkg = new Contract(
      anvil().mockDkg,
      JSON.parse(anvil().mockDkgAbi) as InterfaceAbi,
      devWallet(DKG_OPERATOR)
    );
    census = new OffchainCensus();
    census.add(addresses(2));
    await openEpoch(8);
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  it('creates a DKG_AUTOMATIC process under the committee pool key', async () => {
    const epoch = await registrationEpoch();
    const key = await nextPoolKey(epoch);
    const keys = node.keyRequests.length;
    const created = await sdk.createProcess(election(census, { keyMode: 'dkg' }));
    expect(created.organizerSecret).toBeUndefined();
    expect(node.keyRequests.length).toBe(keys);

    const p = await sdk.getProcess(created.processId);
    expect(p.keyMode).toBe(KeyMode.DkgAutomatic);
    expect(p.dkg).toEqual({
      locked: false,
      council: false,
      epochId: epoch,
      aid: await sdk.registry.aidFor(created.processId),
      resultsRequested: false,
      firstIndex: 0,
      count: 0,
      zeroSkipped: 0,
    });
    expect(p.raw?.encryptionKey).toEqual(key);
  });

  it("creates a DKG_LOCKED process: its key adds the organizer's, until revealed", async () => {
    const epoch = await registrationEpoch();
    const pool = await nextPoolKey(epoch);
    const { processId, organizerSecret } = await sdk.createProcess(
      election(census, { keyMode: 'dkg-locked' })
    );
    if (organizerSecret === undefined) throw new Error('no organizer secret');
    expect(organizerSecret > 0n && organizerSecret < BJJ_SUBGROUP_ORDER).toBe(true);
    const p = await sdk.getProcess(processId);
    expect(p).toMatchObject({ keyMode: KeyMode.DkgLocked, dkg: { locked: true, epochId: epoch } });
    expect(p.raw?.encryptionKey).toEqual(bjjAdd(pool, bjjMulBase(organizerSecret)));

    const wrong = await streamError(
      sdk.revealProcessKeyStream(processId, (organizerSecret % (BJJ_SUBGROUP_ORDER - 1n)) + 1n)
    );
    expect(wrong).toBeInstanceOf(ProcessKeyRevealError);
    expect(wrong).toMatchObject({ revertName: 'InvalidOrganizerSecret' });
    expect(wrong.message).toMatch(/reverted: InvalidOrganizerSecret/);
    const outOfRange = await streamError(sdk.revealProcessKeyStream(processId, 0n));
    expect(outOfRange).toMatchObject({ revertName: 'InvalidOrganizerSecret' });

    await sdk.revealProcessKey(processId, organizerSecret);
    const { dkg: d } = await sdk.registry.getProcess(processId);
    expect(await dkg.getFunction('revealed').staticCall(d?.epochId, d?.aid)).toBe(true);
    expect(await streamError(sdk.revealProcessKeyStream(processId, organizerSecret))).toMatchObject(
      {
        revertName: 'AlreadyRevealed',
      }
    );
  });

  it('retries a locked creation once when the epoch pool runs out under it', async () => {
    const first = await openEpoch(1);
    expect(await registrationEpoch()).toBe(first);
    const events = await withoutAutomine(async () => {
      const stream = sdk.createProcessStream(election(census, { keyMode: 'dkg-locked' }));
      const sent = await nextEvent(stream);
      expect(sent.status).toBe(TxStatus.Pending);
      // Ahead of it in the block: the pool is spent and a new epoch goes live. Their
      // gas is fixed: anvil would estimate it on the pending block, after the creation.
      const tip = {
        maxFeePerGas: parseUnits('200', 'gwei'),
        maxPriorityFeePerGas: parseUnits('100', 'gwei'),
        gasLimit: 1_000_000n,
      };
      await dkg.getFunction('setPoolNext').send(first, 1, tip);
      const { keys } = await newEpoch(4, tip);
      await mine();
      const retry = await nextEvent(stream);
      pools.set(await epochIdOf(await dkgInt('epochNonce')), keys);
      await mine();
      return [sent, retry, ...(await collect(stream))];
    });
    expect(events.map(e => [e.status, e.status === TxStatus.Pending ? e.step : undefined])).toEqual(
      [
        [TxStatus.Pending, undefined],
        [TxStatus.Pending, undefined],
        [TxStatus.Completed, undefined],
      ]
    );
    const done = events[2];
    if (done.status !== TxStatus.Completed) throw new Error('not completed');
    expect(done.response.organizerSecret).toBeDefined();
    const p = await sdk.registry.getProcess(done.response.processId);
    expect(p.dkg?.epochId).not.toBe(first);
    expect(p.dkg?.epochId).toBe(await sdk.registry.getRegistrationEpoch());
  });

  it('refuses a creation when no epoch is live', async () => {
    const live = [...pools.keys()];
    for (const epoch of live) await (await dkg.getFunction('setLive').send(epoch, false)).wait();
    try {
      const automatic = await streamError(
        sdk.createProcessStream(election(census, { keyMode: 'dkg' }))
      );
      expect(automatic).toBeInstanceOf(ProcessCreateError);
      expect(automatic).toMatchObject({ revertName: 'NoLiveEpoch' });
      const locked = await streamError(
        sdk.createProcessStream(election(census, { keyMode: 'dkg-locked' }))
      );
      expect(locked).toBeInstanceOf(ProcessCreateError);
      expect(locked).toMatchObject({ revertName: 'NoLiveEpoch' });
    } finally {
      for (const epoch of live) await (await dkg.getFunction('setLive').send(epoch, true)).wait();
    }
  });

  it('keeps each key mode to its own operations', async () => {
    const automatic = await sdk.createProcess(
      election(census, { keyMode: 'dkg', timing: { duration: 60 }, grace: ANVIL_GRACE.graceFloor })
    );
    const sequencer = await sdk.createProcess(election(census));
    expect(node.keyRequests).toContain(sequencer.processId);

    for (const processId of [automatic.processId, sequencer.processId]) {
      const local = await streamError(sdk.revealProcessKeyStream(processId, 1n));
      expect(local).toBeInstanceOf(ProcessKeyRevealError);
      expect(local).toMatchObject({ revertName: 'InvalidKeyMode' });
    }
    const raw = await streamError(sdk.processes.revealProcessKey(sequencer.processId, 1n));
    expect(raw).toMatchObject({ revertName: 'InvalidKeyMode' });
    expect(await streamError(sdk.finalizeResultsStream(sequencer.processId))).toMatchObject({
      revertName: 'InvalidKeyMode',
    });

    // The committee's tally is finalized after the grace window, once requested.
    const early = await streamError(sdk.finalizeResultsStream(automatic.processId));
    expect(early).toBeInstanceOf(ProcessResultError);
    expect(early).toMatchObject({ revertName: 'GraceOpen' });
    const graceEnd = await sdk.registry.getProcessGraceEnd(automatic.processId);
    await mineAt(graceEnd);
    expect((await sdk.getResultsStatus(automatic.processId)).state).toBe('awaiting-request');
    expect(await streamError(sdk.finalizeResultsStream(automatic.processId))).toMatchObject({
      revertName: 'ResultsNotReady',
    });

    // The DKG modes take no key of their own.
    const next = await sdk.processes.getNextProcessId(await devWallet(ACCOUNT).getAddress());
    const withKey = await streamError(
      sdk.processes.createProcess({
        processId: next,
        keyMode: KeyMode.DkgAutomatic,
        encryptionKey: bjjMulBase(5n),
        startTime: 0,
        duration: 60,
        maxVoters: 2,
        ballotMode: {
          numFields: 2,
          groupSize: 1,
          uniqueValues: false,
          costExponent: 1,
          maxValue: 1n,
          minValue: 0n,
          maxValueSum: 1n,
          minValueSum: 0n,
        },
        census: census.toRegistryCensus(),
        metadataUri: 'https://files.example.org/m.json',
        metadataHash: `0x${'11'.repeat(32)}`,
      })
    );
    expect(withKey).toBeInstanceOf(ProcessCreateError);
    expect(withKey.message).toMatch(/take no encryption key/);
    expect(withKey).not.toBeInstanceOf(DkgDisabledError);
  });
});
