import {
  Contract,
  ZeroHash,
  concat,
  getBytes,
  hexlify,
  keccak256,
  randomBytes,
  sha256,
  toBeHex,
  zeroPadBytes,
  type InterfaceAbi,
} from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import { COUNCIL_ADAPTER_ABI, PROCESS_REGISTRY_ABI } from '../../src/contracts/abis';
import {
  DkgDisabledError,
  ProcessCreateError,
  ProcessResultError,
} from '../../src/contracts/errors';
import { KeyMode, ProcessStatus } from '../../src/contracts/types';
import { bjjMulBase } from '../../src/crypto/babyjubjub';
import {
  ANVIL_GRACE,
  addresses,
  anvil,
  chainProvider,
  chainTime,
  collect,
  connect,
  devWallet,
  election,
  mineAt,
  rpc,
  startNode,
  streamError,
  type MockNode,
} from './harness';
import { TxStatus } from '../../src/contracts/SmartContractService';

const ACCOUNT = 10;
// Runs the mock manager, and is the creator no ceremony authorizes.
const OPERATOR = 11;

describe('COUNCIL key mode (davinci-contracts MockCouncilManager)', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let council: Contract;
  let adapter: string;
  let census: OffchainCensus;
  // The ceremony key, circomlib TE as Council hands it over.
  const key = bjjMulBase(987_654_321n);

  // A Live ceremony under `key` that allows the adapter and authorizes ACCOUNT.
  async function ceremony(options: { allow?: boolean } = {}): Promise<string> {
    const cid = hexlify(randomBytes(12));
    await (await council.getFunction('newCeremony').send(cid, key.x, key.y)).wait();
    if (options.allow !== false) {
      await (await council.getFunction('allowAdapter').send(cid, adapter)).wait();
    }
    const creator = devWallet(ACCOUNT).address;
    await (await council.getFunction('authorizeCreator').send(cid, creator)).wait();
    return cid;
  }

  const councilElection = (ceremonyId: string) =>
    election(census, { keyMode: 'council', ceremonyId });

  // PhaseMode values of the manager.
  const MANUAL = 0;
  const SCHEDULED = 1;

  // A short COUNCIL election on `cid`, past its grace end: results may be requested.
  async function ended(cid: string): Promise<string> {
    const { processId } = await sdk.createProcess(
      election(census, {
        keyMode: 'council',
        ceremonyId: cid,
        timing: { duration: 60 },
        grace: ANVIL_GRACE.graceFloor,
      })
    );
    await mineAt(await sdk.registry.getProcessGraceEnd(processId));
    return processId;
  }

  // The 64 accumulator words: `active` fields as [C1, C2] = [a·B8, b·B8], the rest identity.
  function accumulator(active: [bigint, bigint][] = []): bigint[] {
    const words: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      if (i < active.length) {
        const [c1, c2] = [bjjMulBase(active[i][0]), bjjMulBase(active[i][1])];
        words.push(c1.x, c1.y, c2.x, c2.y);
      } else {
        words.push(0n, 1n, 0n, 1n);
      }
    }
    return words;
  }

  // Settles `acc` as the process's only state leaf (0x04), as the registry's forge suite
  // does: latestStateRoot is word 3 of the process record (`processes` at slot 1). The
  // proof is one zero sibling.
  async function settle(processId: string, acc: bigint[]): Promise<string[]> {
    const value = getBytes(sha256(concat(acc.map(w => toBeHex(w, 32))))).reverse();
    const root = sha256(concat(['0x0400000000000000', value, '0x01']));
    const record = BigInt(keccak256(concat([zeroPadBytes(processId, 32), toBeHex(1n, 32)])));
    await rpc('anvil_setStorageAt', [anvil().councilRegistry, toBeHex(record + 3n, 32), root]);
    expect((await sdk.registry.getProcess(processId)).latestStateRoot).toBe(root);
    return [ZeroHash];
  }

  // What a sequencer sends once the grace window has closed.
  async function requestResults(processId: string, acc: bigint[]): Promise<void> {
    const siblings = await settle(processId, acc);
    const registry = new Contract(
      anvil().councilRegistry,
      PROCESS_REGISTRY_ABI,
      devWallet(OPERATOR)
    );
    const tx = await registry
      .getFunction('requestResultsDecryption')
      .send(processId, acc, siblings);
    await tx.wait();
  }

  beforeAll(async () => {
    node = await startNode('council');
    sdk = await connect(ACCOUNT, node, { registry: 'council' });
    const a = await sdk.registry.getCouncilAdapter();
    if (!a) throw new Error('the council registry has no Council adapter');
    adapter = a;
    council = new Contract(
      anvil().mockCouncil,
      JSON.parse(anvil().mockCouncilAbi) as InterfaceAbi,
      devWallet(OPERATOR)
    );
    census = new OffchainCensus();
    census.add(addresses(2));
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  it('pins a Council adapter that points back at the registry', async () => {
    const info = await sdk.registry.verifyDeployment();
    expect(info.dkgAdapter).toBeNull();
    expect(info.councilAdapter).toBe(adapter);
    const a = new Contract(adapter, COUNCIL_ADAPTER_ABI, chainProvider());
    expect(await a.getFunction('registry').staticCall()).toBe(anvil().councilRegistry);
    expect(await a.getFunction('manager').staticCall()).toBe(anvil().mockCouncil);
  });

  it('creates a process bound to the ceremony, under its key', async () => {
    const cid = await ceremony();
    const keys = node.keyRequests.length;
    const { processId, organizerSecret } = await sdk.createProcess(councilElection(cid));
    expect(organizerSecret).toBeUndefined();
    expect(node.keyRequests.length).toBe(keys);

    const requestId = (await council
      .getFunction('requestIdFor')
      .staticCall(cid, adapter, processId)) as string;
    const p = await sdk.getProcess(processId);
    expect(p.keyMode).toBe(KeyMode.Council);
    expect(p.dkg).toEqual({
      locked: false,
      council: true,
      epochId: cid,
      aid: requestId,
      resultsRequested: false,
      firstIndex: 0,
      count: 0,
      zeroSkipped: 0,
    });
    expect(p.raw?.encryptionKey).toEqual(key);

    // The adapter maps the request back to the process; the manager saw the creator.
    const a = new Contract(adapter, COUNCIL_ADAPTER_ABI, chainProvider());
    const binding = (await a.getFunction('bindings').staticCall(requestId)) as unknown[];
    expect([binding[0], binding[1], binding[2]]).toEqual([cid, 0n, processId]);
    expect(await council.getFunction('bindingCreator').staticCall(adapter, processId)).toBe(
      devWallet(ACCOUNT).address
    );
  });

  it('fails a creation the ceremony does not allow with the manager error', async () => {
    const cid = await ceremony();
    const stranger = await connect(OPERATOR, node, { registry: 'council' });
    const notCreator = await streamError(stranger.createProcessStream(councilElection(cid)));
    expect(notCreator).toBeInstanceOf(ProcessCreateError);
    expect(notCreator).toMatchObject({ revertName: 'NotAuthorizedCreator' });

    const unallowed = await ceremony({ allow: false });
    expect(await streamError(sdk.createProcessStream(councilElection(unallowed)))).toMatchObject({
      revertName: 'NotAllowedAdapter',
    });
    await (await council.getFunction('setPhase').send(cid, 2)).wait(); // Dealing
    expect(await streamError(sdk.createProcessStream(councilElection(cid)))).toMatchObject({
      revertName: 'WrongPhase',
    });
    const unknown = hexlify(randomBytes(12));
    expect(await streamError(sdk.createProcessStream(councilElection(unknown)))).toMatchObject({
      revertName: 'UnknownCeremony',
    });
  });

  it('keeps an all-zero tally locked until a scheduled opening, then publishes it', async () => {
    const cid = await ceremony();
    const opensAt = (await chainTime()) + 30n * 86_400n;
    await (
      await council.getFunction('setDecryptionPolicy').send(cid, SCHEDULED, opensAt, 0)
    ).wait();
    const processId = await ended(cid);
    const locked = {
      state: 'awaiting-opening',
      keyMode: KeyMode.Council,
      decryptionOpening: { mode: 'scheduled', opensAt: new Date(Number(opensAt) * 1000) },
    };
    expect(await sdk.getResultsStatus(processId)).toMatchObject(locked);

    // The request ends the process but publishes nothing: nobody votes, nobody learns it.
    await requestResults(processId, accumulator());
    const p = await sdk.registry.getProcess(processId);
    expect(p.status).toBe(ProcessStatus.ENDED);
    expect(p.dkg).toMatchObject({ resultsRequested: true, count: 0, zeroSkipped: 0b11 });
    expect(p.result).toEqual([]);
    expect(await sdk.getResultsStatus(processId)).toMatchObject(locked);
    const early = await streamError(sdk.finalizeResultsStream(processId));
    expect(early).toBeInstanceOf(ProcessResultError);
    expect(early).toMatchObject({ revertName: 'DecryptionNotOpen' });

    await mineAt(opensAt - 1n);
    expect((await sdk.getResultsStatus(processId)).state).toBe('awaiting-opening');
    await mineAt(opensAt);
    expect((await sdk.getResultsStatus(processId)).state).toBe('finalizable');
    const events = await collect(sdk.finalizeResultsStream(processId));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    const status = await sdk.getResultsStatus(processId);
    expect(status.state).toBe('results');
    expect(status.results?.values).toEqual([0n, 0n]);
  });

  it('waits for a manual opening, then follows the committee', async () => {
    const cid = await ceremony();
    await (await council.getFunction('setDecryptionPolicy').send(cid, MANUAL, 0, 0)).wait();
    const processId = await ended(cid);
    await requestResults(processId, accumulator([[3n, 5n]]));
    const p = await sdk.registry.getProcess(processId);
    expect(p.dkg).toMatchObject({ resultsRequested: true, count: 1, zeroSkipped: 0b10 });
    // Admitted while closed; no date to show, only the organizer opens it.
    expect(await sdk.getResultsStatus(processId)).toMatchObject({
      state: 'awaiting-opening',
      decryptionOpening: { mode: 'manual', opensAt: null },
    });
    expect(await streamError(sdk.finalizeResultsStream(processId))).toMatchObject({
      revertName: 'DecryptionNotOpen',
    });

    await (await council.getFunction('openDecryption').send(cid)).wait();
    expect((await sdk.getResultsStatus(processId)).state).toBe('decrypting');
    const requestId = p.dkg?.aid;
    await (await council.getFunction('setPlaintext').send(requestId, 0, 2)).wait();
    expect((await sdk.getResultsStatus(processId)).state).toBe('finalizable');
    await sdk.finalizeResults(processId);
    const status = await sdk.getResultsStatus(processId);
    expect(status.state).toBe('results');
    expect(status.results?.values).toEqual([2n, 0n]);
  });

  it('refuses the DKG modes on a registry with Council only', async () => {
    const err = await streamError(sdk.createProcessStream(election(census, { keyMode: 'dkg' })));
    expect(err).toBeInstanceOf(DkgDisabledError);
  });
});
