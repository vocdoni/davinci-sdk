import { ZeroHash, getAddress, sha256, toBeHex, zeroPadValue } from 'ethers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DavinciSDK } from '../../src/DavinciSDK';
import { CspSigner } from '../../src/census/CspSigner';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import { OffchainDynamicCensus } from '../../src/census/classes/OffchainDynamicCensus';
import { OnchainCensus } from '../../src/census/classes/OnchainCensus';
import { PublishedCensus } from '../../src/census/classes/PublishedCensus';
import { CensusPublishError } from '../../src/census/errors';
import { CensusOrigin } from '../../src/census/types';
import { OnchainCensusService } from '../../src/contracts/OnchainCensusService';
import {
  DkgDisabledError,
  ProcessCreateError,
  ProcessGraceError,
  WrongProcessIdError,
} from '../../src/contracts/errors';
import { dkgAutomaticParams } from '../../src/contracts/params';
import { SmartContractService, TxStatus } from '../../src/contracts/SmartContractService';
import { KeyMode, ProcessStatus, type NewProcessParams } from '../../src/contracts/types';
import type { ProcessConfigWithMetadata } from '../../src/core/process';
import { computeProcessId } from '../../src/networks';
import { SequencerApiError, SequencerUnavailableError } from '../../src/sequencer/errors';
import {
  ANVIL_GRACE,
  addresses,
  chainTime,
  collect,
  connect,
  deployOwnedCensus,
  devWallet,
  election,
  mine,
  nextEvent,
  startNode,
  streamError,
  unusedUrl,
  withoutAutomine,
  type MockNode,
} from './harness';

const ACCOUNT = 2;
const CENSUS_OWNER = 12;
const CSP_KEY = 13;

// A process the raw registry service takes: sequencer key, static census.
function rawParams(node: MockNode, processId: string, root: string): NewProcessParams {
  return {
    startTime: 0,
    duration: 3600,
    maxVoters: 10,
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
    census: {
      origin: CensusOrigin.OffchainStatic,
      root,
      uri: 'https://files.example.org/census.json',
    },
    metadataUri: 'https://files.example.org/metadata.json',
    metadataHash: sha256('0x01'),
    encryptionKey: node.keyOf(processId),
  };
}

describe('process creation', () => {
  let node: MockNode;
  let sdk: DavinciSDK;
  let organizer: string;

  beforeAll(async () => {
    node = await startNode();
    sdk = await connect(ACCOUNT, node);
    organizer = getAddress(await devWallet(ACCOUNT).getAddress());
  });

  afterAll(async () => {
    await sdk.cancelOpenProcesses({ all: true });
    await node.close();
  });

  it('creates a sequencer-key process under the id the key was issued for', async () => {
    const census = new OffchainCensus();
    census.add(addresses(3));
    const nonce = await sdk.registry.getProcessNonce(organizer);
    const events = await collect(sdk.createProcessStream(election(census)));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    const done = events[1];
    if (done.status !== TxStatus.Completed) throw new Error('not completed');
    const { processId, transactionHash } = done.response;

    expect(processId).toBe(computeProcessId(organizer, sdk.network.processIdPrefix, nonce));
    expect(node.keyRequests.at(-1)).toBe(processId);
    const receipt = await sdk.provider.getTransactionReceipt(transactionHash);
    const block = await sdk.provider.getBlock(receipt?.blockNumber ?? -1);

    const p = await sdk.getProcess(processId);
    expect(p).toMatchObject({
      status: ProcessStatus.READY,
      phase: 'open',
      keyMode: KeyMode.Sequencer,
      creator: organizer,
      maxVoters: 3,
      duration: 3600,
      grace: ANVIL_GRACE.defaultGrace,
      votersCount: 0,
      metadataVerified: true,
      title: 'Anvil election',
      electionPreset: { type: 'single_choice' },
    });
    expect(p.dkg).toBeUndefined();
    expect(p.startDate.getTime()).toBe((block?.timestamp ?? 0) * 1000);
    expect(p.raw?.encryptionKey).toEqual(node.keyOf(processId));
    expect(p.census).toEqual({
      type: CensusOrigin.OffchainStatic,
      root: await census.root(),
      uri: census.censusURI,
    });
    expect(p.questions[0].choices.map(c => c.title)).toEqual(['Yes', 'No']);
    expect(p.graceEnd?.getTime()).toBe(p.endDate.getTime() + ANVIL_GRACE.defaultGrace * 1000);
  });

  it('takes every census origin', async () => {
    const dynamic = new OffchainDynamicCensus();
    dynamic.add([{ key: addresses(1)[0], weight: 5 }, ...addresses(2)]);
    const created = await sdk.createProcess(election(dynamic));
    const p2 = await sdk.getProcess(created.processId);
    expect(p2.census).toMatchObject({
      type: CensusOrigin.OffchainDynamic,
      root: await dynamic.root(),
    });

    // Origin 3: the registry reads the root from the contract.
    const owner = devWallet(CENSUS_OWNER);
    const contract = await deployOwnedCensus(owner);
    await SmartContractService.executeTx(
      new OnchainCensusService(contract, owner).addMembers(addresses(4), [1, 2, 3, 4])
    );
    const onchain = new OnchainCensus(contract);
    const { root } = await onchain.check(sdk.provider);
    const p3 = await sdk.getProcess(
      (await sdk.createProcess(election(onchain, { maxVoters: 100 }))).processId
    );
    expect(p3.census).toEqual({
      type: CensusOrigin.Onchain,
      root: toBeHex(root, 32),
      uri: `onchain://${contract}`,
      contractAddress: contract,
    });

    // Origin 4: the CSP's address is the root.
    const csp = new CspSigner(devWallet(CSP_KEY));
    const cspCensus = await csp.census('https://csp.example.org/vote');
    const p4 = await sdk.getProcess(
      (await sdk.createProcess(election(cspCensus, { maxVoters: 50 }))).processId
    );
    expect(p4.census).toEqual({
      type: CensusOrigin.CSP,
      root: zeroPadValue(await csp.address(), 32).toLowerCase(),
      uri: 'https://csp.example.org/vote',
    });

    // A census file served elsewhere, checked as nodes read it.
    const file = new OffchainCensus();
    file.add(addresses(2));
    const url = node.serve('/elsewhere/census.json', file.serialize());
    const published = new PublishedCensus(CensusOrigin.OffchainStatic, await file.root(), url);
    const p1 = await sdk.getProcess(
      (await sdk.createProcess(election(published, { maxVoters: 2 }))).processId
    );
    expect(p1.census).toMatchObject({ root: await file.root(), uri: url });

    // The registry form, given by hand.
    const byHand = await sdk.createProcess(
      election(
        { type: CensusOrigin.OffchainStatic, root: await file.root(), uri: url },
        { maxVoters: 2 }
      )
    );
    expect((await sdk.getProcess(byHand.processId)).census.root).toBe(await file.root());
  });

  it('checks a census before anything is created', async () => {
    const file = new OffchainCensus();
    file.add(addresses(2));
    const url = node.serve('/wrong/census.json', file.serialize());
    const other = new OffchainCensus();
    other.add(addresses(2));
    const keys = node.keyRequests.length;
    const nonce = await sdk.registry.getProcessNonce(organizer);

    const wrongRoot = new PublishedCensus(CensusOrigin.OffchainStatic, await other.root(), url);
    const err = await streamError(sdk.createProcessStream(election(wrongRoot, { maxVoters: 2 })));
    expect(err).toBeInstanceOf(CensusPublishError);
    const missing = election(
      { type: CensusOrigin.OffchainStatic, root: await file.root(), uri: `${node.url}/nothing` },
      { maxVoters: 2 }
    );
    expect(await streamError(sdk.createProcessStream(missing))).toBeInstanceOf(CensusPublishError);
    // The registry itself is no census contract.
    const notCensus = new OnchainCensus(sdk.network.processRegistry);
    expect(
      await streamError(sdk.createProcessStream(election(notCensus, { maxVoters: 2 })))
    ).toMatchObject({ name: 'CensusContractError' });
    await expect(sdk.createProcess(election(new OnchainCensus(organizer)))).rejects.toThrow(
      /maxVoters is required/
    );

    expect(node.keyRequests.length).toBe(keys);
    expect(await sdk.registry.getProcessNonce(organizer)).toBe(nonce);
  });

  it('creates a process paused, or starting later', async () => {
    const census = new OffchainCensus();
    census.add(addresses(2));
    const paused = await sdk.getProcess(
      (await sdk.createProcess(election(census, { paused: true }))).processId
    );
    expect(paused).toMatchObject({ status: ProcessStatus.PAUSED, phase: 'paused' });

    const start = (await chainTime()) + 600n;
    const later = await sdk.getProcess(
      (
        await sdk.createProcess(
          election(census, { timing: { startDate: Number(start), duration: 1200 } })
        )
      ).processId
    );
    expect(later).toMatchObject({ phase: 'upcoming', duration: 1200 });
    expect(later.startDate.getTime()).toBe(Number(start) * 1000);
    expect(later.timeRemaining).toBeLessThan(0);

    const end = (await chainTime()) + 900n;
    const byEnd = await sdk.getProcess(
      (await sdk.createProcess(election(census, { timing: { endDate: Number(end) } }))).processId
    );
    // The duration runs from the chain head, so the end falls a block later.
    expect(BigInt(byEnd.endDate.getTime() / 1000)).toBeGreaterThanOrEqual(end);
  });

  it('sets the grace window right after the creation', async () => {
    const census = new OffchainCensus();
    census.add(addresses(2));
    const events = await collect(
      sdk.createProcessStream(election(census, { grace: ANVIL_GRACE.graceFloor }))
    );
    expect(events.map(e => [e.status, e.status === TxStatus.Pending ? e.step : undefined])).toEqual(
      [
        [TxStatus.Pending, undefined],
        [TxStatus.Pending, 'setProcessGrace'],
        [TxStatus.Completed, undefined],
      ]
    );
    const done = events[2];
    if (done.status !== TxStatus.Completed) throw new Error('not completed');
    expect(done.response.grace).toEqual({
      seconds: ANVIL_GRACE.graceFloor,
      transactionHash: events[1].status === TxStatus.Pending ? events[1].hash : '',
    });
    expect((await sdk.getProcess(done.response.processId)).grace).toBe(ANVIL_GRACE.graceFloor);

    const nonce = await sdk.registry.getProcessNonce(organizer);
    const low = await streamError(
      sdk.createProcessStream(election(census, { grace: ANVIL_GRACE.graceFloor - 1 }))
    );
    expect(low).toBeInstanceOf(ProcessGraceError);
    expect(low).toMatchObject({ revertName: 'InvalidGrace' });
    expect(await sdk.registry.getProcessNonce(organizer)).toBe(nonce);
  });

  it('refuses what the registry would, before asking for a key', async () => {
    const census = new OffchainCensus();
    census.add(addresses(2));
    const keys = node.keyRequests.length;
    const cases: [Partial<ProcessConfigWithMetadata>, string][] = [
      [{ maxVoters: 2_000_000_000_000 }, 'MaxPossibleResultCapExceeded'],
      [{ maxVoters: 0 }, 'InvalidMaxVoters'],
      [{ timing: { startDate: Number(await chainTime()) - 10, duration: 60 } }, 'InvalidStartTime'],
      [
        {
          electionPreset: undefined,
          ballot: {
            numFields: 17,
            maxValue: '1',
            minValue: '0',
            uniqueValues: false,
            costExponent: 1,
            maxValueSum: '1',
            minValueSum: '0',
          },
        },
        'InvalidMaxCount',
      ],
    ];
    for (const [overrides, revertName] of cases) {
      const err = await streamError(sdk.createProcessStream(election(census, overrides)));
      expect(err).toBeInstanceOf(ProcessCreateError);
      expect(err).toMatchObject({ revertName });
    }
    expect(node.keyRequests.length).toBe(keys);
  });

  it('decodes the reverts of the registry itself', async () => {
    const registry = sdk.processes;
    const next = await registry.getNextProcessId(organizer);
    const census = new OffchainCensus();
    census.add(addresses(2));
    const params = rawParams(node, next, await census.root());
    const cases: [Partial<NewProcessParams>, string][] = [
      [{ metadataHash: ZeroHash }, 'InvalidMetadata'],
      [{ metadataUri: '' }, 'InvalidMetadata'],
      [{ maxVoters: 0 }, 'InvalidMaxVoters'],
      [{ startTime: (await chainTime()) - 10n }, 'InvalidStartTime'],
      [{ encryptionKey: { x: 0n, y: 1n } }, 'InvalidEncryptionKey'],
      [{ census: { ...params.census, root: ZeroHash } }, 'InvalidCensusRoot'],
      [{ census: { ...params.census, uri: '' } }, 'InvalidCensusURI'],
      [
        { census: { ...params.census, origin: CensusOrigin.CSP, root: `0x01${'00'.repeat(20)}` } },
        'InvalidCensusRoot',
      ],
      [
        { census: { ...params.census, origin: CensusOrigin.Onchain, contractAddress: organizer } },
        'InvalidCensusAddress',
      ],
      [{ encryptionKey: undefined, dkg: dkgAutomaticParams() }, 'DKGDisabled'],
    ];
    for (const [overrides, revertName] of cases) {
      const err = await streamError(registry.newProcess({ ...params, ...overrides }));
      expect(err, revertName).toBeInstanceOf(ProcessCreateError);
      expect(err, revertName).toMatchObject({ revertName });
    }
    expect(await registry.getNextProcessId(organizer)).toBe(next);

    // A key issued for another id is refused before sending.
    await expect(
      SmartContractService.executeTx(
        registry.newProcess(params, {
          expectedProcessId: computeProcessId(organizer, sdk.network.processIdPrefix, 999),
        })
      )
    ).rejects.toThrow(/assigns .* next, the key was issued for/);
  });

  it('refuses the DKG key modes on a registry without DKG', async () => {
    const census = new OffchainCensus();
    census.add(addresses(2));
    const uploads = node.uploads.length;
    for (const keyMode of ['dkg', 'dkg-locked'] as const) {
      const err = await streamError(sdk.createProcessStream(election(census, { keyMode })));
      expect(err).toBeInstanceOf(DkgDisabledError);
    }
    // Refused before the census or the metadata is published.
    expect(node.uploads.length).toBe(uploads);
  });

  it('fails with WrongProcessIdError when another creation takes the key id', async () => {
    const registry = sdk.processes;
    const next = await registry.getNextProcessId(organizer);
    const census = new OffchainCensus();
    census.add(addresses(2));
    const params = rawParams(node, next, await census.root());
    const [first, second] = await withoutAutomine(async () => {
      const a = registry.newProcess(params, { expectedProcessId: next });
      const b = registry.newProcess(params, { expectedProcessId: next });
      // Both see `next` as the registry's next id and both simulate fine.
      expect((await nextEvent(a)).status).toBe(TxStatus.Pending);
      expect((await nextEvent(b)).status).toBe(TxStatus.Pending);
      await mine();
      return [await nextEvent(a), await nextEvent(b)];
    });
    expect(first).toMatchObject({ status: TxStatus.Completed, response: { processId: next } });
    expect(second.status).toBe(TxStatus.Failed);
    const err = second.status === TxStatus.Failed ? second.error : undefined;
    expect(err).toBeInstanceOf(WrongProcessIdError);
    const created = computeProcessId(
      organizer,
      sdk.network.processIdPrefix,
      BigInt(`0x${next.slice(-14)}`) + 1n
    );
    expect(err).toMatchObject({ created, expected: next });

    // The process exists under the other id: cancel it.
    const { canceled } = await sdk.cancelOpenProcesses({ processIds: [created] });
    expect(canceled).toEqual([created]);
    expect((await sdk.getProcess(created)).status).toBe(ProcessStatus.CANCELED);
  });

  it('serializes concurrent creations from one account', async () => {
    const census = new OffchainCensus();
    census.add(addresses(2));
    await census.root();
    const before = node.keyRequests.length;
    const results = await Promise.all([
      sdk.createProcess(election(census)),
      sdk.createProcess(election(census)),
      sdk.createProcess(election(census)),
    ]);
    const ids = results.map(r => r.processId);
    expect(new Set(ids).size).toBe(3);
    // Each key was asked for the id its process got.
    expect([...node.keyRequests.slice(before)].sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect((await sdk.registry.getProcess(id)).encryptionKey).toEqual(node.keyOf(id));
    }
  });

  it('sends nothing when the key node refuses or is down', async () => {
    const census = new OffchainCensus();
    census.add(addresses(2));
    const nonce = await sdk.registry.getProcessNonce(organizer);
    node.keyError = { status: 429, body: { error: 'rate limit exceeded', code: 42901 } };
    try {
      const err = await streamError(sdk.createProcessStream(election(census)));
      expect(err).toBeInstanceOf(SequencerApiError);
      expect(err).toMatchObject({ status: 429, code: 42901 });
    } finally {
      node.keyError = undefined;
    }

    const lonely = await connect(ACCOUNT, node, {
      config: { sequencerUrls: [await unusedUrl()], keySequencerUrl: undefined },
    });
    expect(await streamError(lonely.createProcessStream(election(census)))).toBeInstanceOf(
      SequencerUnavailableError
    );
    expect(await sdk.registry.getProcessNonce(organizer)).toBe(nonce);
  });
});
