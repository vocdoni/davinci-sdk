import {
  Contract,
  ContractEventPayload,
  Interface,
  Log,
  NonceManager,
  id,
  type Provider,
  Wallet,
  ZeroAddress,
  getAddress,
  keccak256,
  sha256,
  toQuantity,
  toUtf8Bytes,
  zeroPadValue,
  type Result,
} from 'ethers';
import {
  COUNCIL_ADAPTER_ABI,
  COUNCIL_MANAGER_ERRORS_ABI,
  CensusNotUpdatable,
  CouncilDisabledError,
  DAVINCI_DKG_ADAPTER_ABI,
  DKG_APP_MANAGER_ABI,
  DeploymentPinError,
  DkgDisabledError,
  KeyMode,
  LOG_BLOCK_RANGE,
  PROCESS_REGISTRY_ABI,
  ProcessCreateError,
  ProcessDurationError,
  ProcessMaxVotersError,
  ProcessNotFoundError,
  ProcessRegistryService,
  ProcessResultError,
  ProcessStatus,
  SmartContractService,
  TxStatus,
  WrongProcessIdError,
  ZISK_VERIFIER_ABI,
  councilParams,
  dkgAutomaticParams,
  dkgLockedParams,
  metadataHash,
  parseRegistryLog,
  parseRegistryLogs,
  sequencerKeyParams,
  type ContractServiceError,
  type CreateProcessParams,
  type NewProcessParams,
  type TxStatusEvent,
} from '../../../src/contracts';
import { CensusOrigin } from '../../../src/census/types';
import { bjjMulBase, pointToReducedTE, proveOrganizerKey } from '../../../src/crypto';
import { RELEASE_PINS } from '../../../src/protocol';
import { MockChain, revertWith, type CallHandler } from '../../helpers/mockChain';

const REGISTRY = '0x6702e0141B6b72bCF8C1bdff20A82A35C5502E7D';
const VERIFIER = '0x150547716bD6f15D872508b66b2ae7ce17677C9C';
const ADAPTER = '0xE9559c78E7ff8c19937A0657a092A221E90CCBC3';
const COUNCIL_ADAPTER = getAddress(`0x${'c0'.repeat(20)}`);
const CID = `0x${'c1'.repeat(12)}`;
const RID = `0x${'7e'.repeat(32)}`;
const KEY = '0x' + '11'.repeat(32);
const iface = new Interface(PROCESS_REGISTRY_ABI);
const PID = `0x${'ab'.repeat(20)}f5848002${'00'.repeat(6)}01`;
const KEY_POINT = bjjMulBase(12345n);

type Process = Record<string, unknown>;

function process(overrides: Process = {}): Process {
  return {
    status: 0,
    organizationId: '0x' + '0a'.repeat(20),
    encryptionKey: { x: KEY_POINT.x, y: KEY_POINT.y },
    latestStateRoot: `0x${'04'.repeat(32)}`,
    result: [],
    startTime: 1_700_000_000n,
    duration: 3600n,
    maxVoters: 100n,
    votersCount: 2n,
    overwrittenVotesCount: 1n,
    creationBlock: 48_600_000n,
    batchNumber: 3n,
    metadataURI: 'https://example.org/meta.json',
    metadataHash: `0x${'aa'.repeat(32)}`,
    ballotMode: {
      uniqueValues: false,
      numFields: 4,
      groupSize: 1,
      costExponent: 1,
      maxValue: 5n,
      minValue: 0n,
      maxValueSum: 20n,
      minValueSum: 0n,
    },
    census: {
      censusOrigin: 1,
      censusRoot: `0x${'00'.repeat(31)}05`,
      contractAddress: ZeroAddress,
      censusURI: 'https://example.org/census.json',
      onchainAllowAnyValidRoot: false,
    },
    keyMode: 0,
    dkgEpochId: `0x${'00'.repeat(12)}`,
    dkgFirstIndex: 0,
    dkgCount: 0,
    dkgZeroSkipped: 0,
    dkgResultsRequested: false,
    dkgAid: ZeroHash32(),
    grace: 180,
    lastVoteAt: 1_700_001_000n,
    ...overrides,
  };
}

function ZeroHash32(): string {
  return `0x${'00'.repeat(32)}`;
}

const pinsOk: Record<string, CallHandler> = {
  batchProgramVK: () => [RELEASE_PINS.batchProgramVK],
  resultsProgramVK: () => [RELEASE_PINS.resultsProgramVK],
  rootCVadcopFinal: () => [RELEASE_PINS.rootCVadcopFinal],
  ballotVKHash: () => [RELEASE_PINS.ballotVKHash],
  chainID: () => [100],
  ziskVerifier: () => [VERIFIER],
  dkgAdapter: () => [ADAPTER],
  councilAdapter: () => [COUNCIL_ADAPTER],
};

// A registry on a mock chain, with `calls` overriding the defaults.
function setup(calls: Record<string, CallHandler> = {}) {
  const chain = new MockChain();
  const wallet = new Wallet(KEY, chain);
  const state = { process: process({ organizationId: wallet.address }) };
  chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, {
    ...pinsOk,
    getProcess: () => [state.process],
    getNextProcessId: () => [PID],
    getProcessEndTime: () => [1_700_003_600n],
    getProcessGraceEnd: () => [1_700_003_780n],
    defaultGrace: () => [180],
    graceFloor: () => [150],
    graceCeil: () => [600],
    graceMaxTotal: () => [1800],
    noticeMin: () => [60],
    pidPrefix: () => [0xf5848002],
    processCount: () => [7],
    processNonce: () => [2n],
    MAX_STATUS: () => [4],
    aidFor: () => [`0x${'0d'.repeat(32)}`],
    newProcess: () => [PID.slice(0, 64)],
    setProcessStatus: () => [],
    setProcessCensus: () => [],
    setProcessMetadata: () => [],
    setProcessDuration: () => [],
    setProcessMaxVoters: () => [],
    setProcessGrace: () => [],
    revealProcessKey: () => [],
    finalizeResultsFromDKG: () => [],
    ...calls,
  });
  chain.contract(ADAPTER, DAVINCI_DKG_ADAPTER_ABI, {
    registrationEpoch: () => [`0x${'0e'.repeat(12)}`],
    registry: () => [REGISTRY],
  });
  const councilCalls: unknown[][] = [];
  chain.contract(COUNCIL_ADAPTER, COUNCIL_ADAPTER_ABI, {
    registry: () => [REGISTRY],
    plaintexts: args => {
      councilCalls.push([...args]);
      return [true, [4n, 9n]];
    },
  });
  chain.contract(VERIFIER, ZISK_VERIFIER_ABI, {
    getRootCVadcopFinal: () => [RELEASE_PINS.rootCVadcopFinal],
  });
  chain.setCode(VERIFIER, '0x6001600101');
  const registry = new ProcessRegistryService(REGISTRY, wallet, { receiptTimeoutMs: 2000 });
  return { chain, wallet, registry, state, councilCalls };
}

async function drain<T>(stream: AsyncGenerator<TxStatusEvent<T>>): Promise<TxStatusEvent<T>[]> {
  const out: TxStatusEvent<T>[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function failure<T>(events: TxStatusEvent<T>[]): ContractServiceError {
  const last = events[events.length - 1];
  if (last.status !== TxStatus.Failed && last.status !== TxStatus.Reverted) {
    throw new Error(`stream ended with ${last.status}`);
  }
  return (last.status === TxStatus.Failed ? last.error : last.error) as ContractServiceError;
}

const createdLog = (processId: string, creator: string, address = REGISTRY) => {
  const { topics, data } = iface.encodeEventLog('ProcessCreated', [processId, creator]);
  return { address, topics, data };
};

const baseParams = (): NewProcessParams => ({
  startTime: 0,
  duration: 3600,
  maxVoters: 100,
  ballotMode: {
    numFields: 4,
    groupSize: 1,
    uniqueValues: false,
    costExponent: 1,
    maxValue: 5n,
    minValue: 0n,
    maxValueSum: 20n,
    minValueSum: 0n,
  },
  census: {
    origin: CensusOrigin.CSP,
    root: '0x' + '5a'.repeat(20),
    uri: 'https://csp.example.org',
  },
  metadataUri: 'https://example.org/meta.json',
  metadataHash: metadataHash('{"title":"x"}'),
  encryptionKey: KEY_POINT,
});

describe('ProcessRegistryService reads', () => {
  it('decodes getProcess, grace window included', async () => {
    const { registry, wallet } = setup();
    const p = await registry.getProcess(PID.toUpperCase().replace('0X', '0x'));
    expect(p).toEqual({
      processId: PID,
      status: ProcessStatus.READY,
      organizationId: wallet.address,
      encryptionKey: KEY_POINT,
      latestStateRoot: `0x${'04'.repeat(32)}`,
      result: [],
      startTime: 1_700_000_000n,
      duration: 3600n,
      maxVoters: 100n,
      votersCount: 2n,
      overwrittenVotesCount: 1n,
      creationBlock: 48_600_000n,
      batchNumber: 3n,
      metadataUri: 'https://example.org/meta.json',
      metadataHash: `0x${'aa'.repeat(32)}`,
      ballotMode: {
        numFields: 4,
        groupSize: 1,
        uniqueValues: false,
        costExponent: 1,
        maxValue: 5n,
        minValue: 0n,
        maxValueSum: 20n,
        minValueSum: 0n,
      },
      census: {
        origin: CensusOrigin.OffchainStatic,
        root: `0x${'00'.repeat(31)}05`,
        contractAddress: ZeroAddress,
        uri: 'https://example.org/census.json',
      },
      keyMode: KeyMode.Sequencer,
      grace: 180,
      lastVoteAt: 1_700_001_000n,
    });
  });

  it('decodes the DKG side of a locked process and refuses unknown ids', async () => {
    const { registry, state } = setup();
    state.process = process({
      status: 4,
      keyMode: 2,
      result: [3n, 0n, 7n, 1n],
      dkgEpochId: `0x${'0e'.repeat(12)}`,
      dkgAid: `0x${'0d'.repeat(32)}`,
      dkgFirstIndex: 12,
      dkgCount: 3,
      dkgZeroSkipped: 2,
      dkgResultsRequested: true,
    });
    const p = await registry.getProcess(PID);
    expect(p.status).toBe(ProcessStatus.RESULTS);
    expect(p.result).toEqual([3n, 0n, 7n, 1n]);
    expect(p.keyMode).toBe(KeyMode.DkgLocked);
    expect(p.dkg).toEqual({
      locked: true,
      council: false,
      epochId: `0x${'0e'.repeat(12)}`,
      aid: `0x${'0d'.repeat(32)}`,
      resultsRequested: true,
      firstIndex: 12,
      count: 3,
      zeroSkipped: 2,
    });

    state.process = process({ organizationId: ZeroAddress });
    await expect(registry.getProcess(PID)).rejects.toBeInstanceOf(ProcessNotFoundError);
    await expect(registry.getProcess('0x1234')).rejects.toThrow(TypeError);
  });

  it('decodes a COUNCIL process, routes its plaintexts and refuses newer modes', async () => {
    const { registry, state, councilCalls, chain } = setup();
    state.process = process({
      status: 1,
      keyMode: 3,
      dkgEpochId: CID,
      dkgAid: RID,
      dkgCount: 2,
      dkgZeroSkipped: 0b1010,
      dkgResultsRequested: true,
    });
    const p = await registry.getProcess(PID);
    expect(p.keyMode).toBe(KeyMode.Council);
    const dkg = p.dkg;
    expect(dkg).toEqual({
      locked: false,
      council: true,
      epochId: CID,
      aid: RID,
      resultsRequested: true,
      firstIndex: 0,
      count: 2,
      zeroSkipped: 0b1010,
    });
    if (!dkg) throw new Error('no dkg side');
    // The plaintexts come from the Council adapter, the whole request at once.
    expect(await registry.getDkgPlaintexts(dkg)).toEqual({ ready: true, values: [4n, 9n] });
    expect(councilCalls).toEqual([[CID, RID, 0n, 2n]]);
    const before = chain.requests.length;
    expect(await registry.isProcessKeyRevealed(dkg)).toBe(false);
    expect(chain.requests).toHaveLength(before);

    state.process = process({ keyMode: 4 });
    await expect(registry.getProcess(PID)).rejects.toThrow('unknown key mode 4');
  });

  it('reads the Council adapter of a registry with, without or before the mode', async () => {
    const { registry, chain } = setup();
    expect(await registry.getCouncilAdapter()).toBe(COUNCIL_ADAPTER);

    const off = setup({ councilAdapter: () => [ZeroAddress] });
    expect(await off.registry.getCouncilAdapter()).toBeNull();
    const dkg = { council: true, count: 1 } as Parameters<typeof registry.getDkgPlaintexts>[0];
    await expect(off.registry.getDkgPlaintexts(dkg)).rejects.toBeInstanceOf(CouncilDisabledError);

    // A registry from before the mode has no councilAdapter(): it reverts without data.
    const old = PROCESS_REGISTRY_ABI.filter(f => f.name !== 'councilAdapter');
    chain.contract(REGISTRY, old, pinsOk);
    expect(await registry.getCouncilAdapter()).toBeNull();
    // Any other failure is not taken for a missing adapter.
    chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, {
      ...pinsOk,
      councilAdapter: () => revertWith(PROCESS_REGISTRY_ABI, 'Unauthorized'),
    });
    await expect(registry.getCouncilAdapter()).rejects.toThrow();
  });

  it('reads the grace window, pins and DKG entry points', async () => {
    const { registry } = setup();
    expect(await registry.getGraceParams()).toEqual({
      defaultGrace: 180,
      graceFloor: 150,
      graceCeil: 600,
      graceMaxTotal: 1800,
      noticeMin: 60,
    });
    expect(await registry.getProcessGraceEnd(PID)).toBe(1_700_003_780n);
    expect(await registry.getProcessEndTime(PID)).toBe(1_700_003_600n);
    expect(await registry.getNextProcessId(ZeroAddress)).toBe(PID);
    expect(await registry.getPidPrefix()).toBe('0xf5848002');
    expect(await registry.getProcessCount()).toBe(7);
    expect(await registry.getChainID()).toBe('100');
    expect(await registry.getZiskVerifier()).toBe(VERIFIER);
    expect(await registry.getBallotVKHash()).toBe(RELEASE_PINS.ballotVKHash);
    expect(await registry.getDkgAdapter()).toBe(ADAPTER);
    expect(await registry.aidFor(PID)).toBe(`0x${'0d'.repeat(32)}`);
    expect(await registry.getRegistrationEpoch()).toBe(`0x${'0e'.repeat(12)}`);
  });

  it('reports a registry without DKG as DkgDisabledError', async () => {
    const { registry } = setup({
      dkgAdapter: () => [ZeroAddress],
      aidFor: () => revertWith(PROCESS_REGISTRY_ABI, 'DKGDisabled'),
    });
    expect(await registry.getDkgAdapter()).toBeNull();
    await expect(registry.getRegistrationEpoch()).rejects.toBeInstanceOf(DkgDisabledError);
    const err = (await registry.aidFor(PID).catch((e: unknown) => e)) as DkgDisabledError;
    expect(err).toBeInstanceOf(DkgDisabledError);
    expect(err.revertName).toBe('DKGDisabled');
  });

  it('queries the events of one process', async () => {
    const { registry, chain, wallet } = setup();
    const status = iface.encodeEventLog('ProcessStatusChanged', [PID, 0, 1]);
    chain.logs = [
      createdLog(PID, wallet.address),
      { address: REGISTRY, topics: status.topics, data: status.data },
    ];
    const events = await registry.queryEvents({ processId: PID, fromBlock: 48_600_000 });
    expect(events.map(e => e.name)).toEqual(['ProcessCreated', 'ProcessStatusChanged']);
    const filter = (chain.calls('eth_getLogs')[0].params as Record<string, unknown>[])[0];
    expect(filter.address).toBe(REGISTRY.toLowerCase());
    expect(filter.fromBlock).toBe(toQuantity(48_600_000));
    // An indexed bytes31 is right-padded to its topic.
    expect((filter.topics as unknown[])[1]).toBe(`${PID}00`);
  });
});

describe('ProcessRegistryService.queryEvents', () => {
  it("starts at a known network's deployment block unless told otherwise", async () => {
    const { registry, chain } = setup();
    await registry.queryEvents({ processId: PID });
    const filter = (chain.calls('eth_getLogs')[0].params as Record<string, unknown>[])[0];
    expect(filter.fromBlock).toBe(toQuantity(48_504_090));

    // Another registry has no known deployment block.
    const other = new ProcessRegistryService('0x' + '77'.repeat(20), chain);
    await expect(other.queryEvents()).rejects.toThrow('fromBlock is required');
    await other.queryEvents({ fromBlock: 5 });
    expect((chain.calls('eth_getLogs')[1].params as Record<string, unknown>[])[0].fromBlock).toBe(
      '0x5'
    );
  });

  it('reads in windows public RPCs accept, newest first, and stops when told', async () => {
    const { registry, chain, wallet } = setup();
    chain.headBlock = 48_612_345;
    chain.logRangeCap = LOG_BLOCK_RANGE;
    chain.logs = [
      { ...createdLog(PID, wallet.address), block: 48_600_010 },
      { ...createdLog(PID, wallet.address), block: 48_611_000 },
    ];
    // One call over the whole range is refused.
    await expect(registry.queryEvents({ processId: PID, fromBlock: 48_600_000 })).rejects.toThrow(
      'max block range'
    );

    const ranges = () =>
      chain.calls('eth_getLogs').map(c => {
        const f = (c.params as { fromBlock: string; toBlock: string }[])[0];
        return [Number(f.fromBlock), Number(f.toBlock)];
      });
    chain.requests.length = 0;
    const found: number[][] = [];
    for await (const events of registry.eventWindows({ processId: PID, fromBlock: 48_600_000 })) {
      found.push(events.map(e => e.blockNumber));
    }
    expect(ranges()).toEqual([
      [48_607_346, 48_612_345],
      [48_602_346, 48_607_345],
      [48_600_000, 48_602_345],
    ]);
    expect(found).toEqual([[48_611_000], [], [48_600_010]]);

    // Stopping early asks for nothing more.
    chain.requests.length = 0;
    for await (const events of registry.eventWindows({ fromBlock: 48_600_000, blockRange: 100 })) {
      if (events.length === 0) break;
    }
    expect(ranges()).toEqual([[48_612_246, 48_612_345]]);
    await expect(registry.eventWindows({ blockRange: 0 }).next()).rejects.toThrow(
      'blockRange 0 is not a positive integer'
    );
  });
});

describe('ProcessRegistryService.newProcess', () => {
  it('sends the 10 arguments and reads the id from ProcessCreated', async () => {
    const { registry, chain, wallet } = setup();
    chain.onMine = () => ({
      status: 1,
      logs: [
        createdLog(`0x${'cd'.repeat(31)}`, wallet.address, VERIFIER), // another contract
        createdLog(`0x${'ce'.repeat(31)}`, '0x' + '01'.repeat(20)), // another creator
        createdLog(PID, wallet.address),
      ],
    });
    const events = await drain(registry.newProcess(baseParams(), { expectedProcessId: PID }));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    const done = events[1] as { response: { processId: string; transactionHash: string } };
    expect(done.response.processId).toBe(PID);
    expect(done.response.transactionHash).toBe((events[0] as { hash: string }).hash);

    const args = iface.decodeFunctionData('newProcess', chain.sent[0].data);
    expect(chain.sent[0].to).toBe(REGISTRY);
    expect(args[0]).toBe(0n);
    expect(args.slice(1, 4)).toEqual([0n, 3600n, 100n]);
    const census = args[5] as Result;
    expect(census.toArray()).toEqual([
      4n,
      zeroPadValue('0x' + '5a'.repeat(20), 32),
      ZeroAddress,
      'https://csp.example.org',
      false,
    ]);
    expect(args[6]).toBe('https://example.org/meta.json');
    expect(args[7]).toBe(sha256(toUtf8Bytes('{"title":"x"}')));
    expect((args[8] as Result).toArray()).toEqual([KEY_POINT.x, KEY_POINT.y]);
    expect((args[9] as Result).toArray()).toEqual([0n, `0x${'00'.repeat(12)}`, 0n, 0n, 0n, 0n, 0n]);
    expect((args[4] as Result).toArray()).toEqual([false, 4n, 1n, 1n, 5n, 0n, 20n, 0n]);
  });

  it('fails before sending when the registry no longer assigns the expected id', async () => {
    const next = `0x${'ab'.repeat(20)}f5848002${'00'.repeat(6)}02`;
    const { registry, chain, wallet } = setup({ getNextProcessId: () => [next] });
    const err = failure(await drain(registry.newProcess(baseParams(), { expectedProcessId: PID })));
    expect(err).toBeInstanceOf(ProcessCreateError);
    expect(err.message).toBe(
      `newProcess: the registry assigns ${next} next, the key was issued for ${PID}`
    );
    // One read: getNextProcessId of the organizer. No simulation, no estimate, no send.
    const calls = chain.calls('eth_call');
    expect(calls).toHaveLength(1);
    const data = (calls[0].params as { data: string }[])[0].data;
    expect(iface.decodeFunctionData('getNextProcessId', data)[0]).toBe(wallet.address);
    expect(chain.calls('eth_estimateGas')).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it('fails with WrongProcessIdError when another process took the id', async () => {
    const { registry, chain, wallet } = setup();
    const other = `0x${'ab'.repeat(20)}f5848002${'00'.repeat(6)}02`;
    chain.onMine = () => ({ status: 1, logs: [createdLog(other, wallet.address)] });
    const err = failure(await drain(registry.newProcess(baseParams(), { expectedProcessId: PID })));
    expect(err).toBeInstanceOf(WrongProcessIdError);
    expect(err).toMatchObject({ created: other, expected: PID });
  });

  it('simulates first and fails with the decoded revert, sending nothing', async () => {
    const reverts = [
      [
        'MaxPossibleResultCapExceeded',
        revertWith(PROCESS_REGISTRY_ABI, 'MaxPossibleResultCapExceeded'),
      ],
      // Bubbled up from the DKG adapter and the DKG app manager: not in the registry ABI.
      ['NoLiveEpoch', revertWith(DAVINCI_DKG_ADAPTER_ABI, 'NoLiveEpoch')],
      ['PoolExhausted', revertWith(DKG_APP_MANAGER_ABI, 'PoolExhausted')],
    ] as const;
    for (const [name, revert] of reverts) {
      const { registry, chain, wallet } = setup({ newProcess: () => revert });
      const err = failure(
        await drain(registry.newProcess({ ...baseParams(), dkg: dkgAutomaticParams() }))
      );
      expect(err).toBeInstanceOf(ProcessCreateError);
      expect(err.revertName).toBe(name);
      expect(err.message).toBe(`newProcess reverted: ${name}`);
      // Simulated with eth_call from the organizer, before any gas estimate or signature.
      const [call] = chain.calls('eth_call');
      expect((call.params as { from: string }[])[0].from).toBe(wallet.address.toLowerCase());
      expect(chain.calls('eth_estimateGas')).toHaveLength(0);
      expect(chain.sent).toHaveLength(0);
    }
  });

  it('refuses a ballot mode that does not pack before any request', async () => {
    const { registry, chain } = setup();
    const params = baseParams();
    params.ballotMode = { ...params.ballotMode, maxValue: 1n << 48n };
    const err = failure(await drain(registry.newProcess(params)));
    expect(err).toBeInstanceOf(ProcessCreateError);
    expect(chain.requests).toHaveLength(0);
  });

  it('passes the DKG-locked key and proof, with no election key', async () => {
    const { registry, chain, wallet } = setup();
    chain.onMine = () => ({ status: 1, logs: [createdLog(PID, wallet.address)] });
    const epochId = await registry.getRegistrationEpoch();
    const aid = await registry.aidFor(PID);
    const proof = proveOrganizerKey({ epochId, aid, secret: 5n, witness: 7n });
    const dkg = dkgLockedParams(epochId, proof);
    const params = { ...baseParams(), encryptionKey: undefined, dkg };
    await drain(registry.newProcess(params));
    const args = iface.decodeFunctionData('newProcess', chain.sent[0].data);
    expect((args[8] as Result).toArray()).toEqual([0n, 0n]);
    expect((args[9] as Result).toArray()).toEqual([
      2n,
      epochId,
      proof.pkX,
      proof.pkY,
      proof.aX,
      proof.aY,
      proof.z,
    ]);
  });
});

describe('ProcessRegistryService.createProcess', () => {
  const NEW_PROCESS = id(
    'newProcess(uint8,uint256,uint256,uint256,(bool,uint8,uint8,uint8,uint256,uint256,uint256,uint256),(uint8,bytes32,address,string,bool),string,bytes32,(uint256,uint256),(uint8,bytes12,uint256,uint256,uint256,uint256,uint256))'
  ).slice(0, 10);
  // Simulations of newProcess (eth_call), whatever else was read.
  const simulations = (chain: MockChain) =>
    chain
      .calls('eth_call')
      .filter(c => (c.params as { data: string }[])[0].data.startsWith(NEW_PROCESS));
  const sentDkg = (chain: MockChain, i: number): unknown[] =>
    (
      iface.decodeFunctionData('newProcess', chain.sent[i].data)[9] as Result
    ).toArray() as unknown[];
  const params = (keyMode: KeyMode) => {
    const { encryptionKey, ...rest } = baseParams();
    return {
      ...rest,
      processId: PID,
      keyMode,
      ...(keyMode === KeyMode.Sequencer && { encryptionKey }),
    };
  };

  it('creates a SEQUENCER process under the id its key was issued for', async () => {
    const { registry, chain, wallet } = setup();
    chain.onMine = () => ({ status: 1, logs: [createdLog(PID, wallet.address)] });
    const events = await drain(registry.createProcess(params(KeyMode.Sequencer)));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    const done = events[1] as { response: { processId: string; organizerSecret?: bigint } };
    expect(done.response.processId).toBe(PID);
    expect(done.response.organizerSecret).toBeUndefined();
    expect(sentDkg(chain, 0)[0]).toBe(0n);

    const noKey = failure(
      await drain(
        registry.createProcess({ ...params(KeyMode.Sequencer), encryptionKey: undefined })
      )
    );
    expect(noKey.message).toContain('SEQUENCER mode needs the sequencer key');
    const keyed = failure(
      await drain(
        registry.createProcess({ ...params(KeyMode.DkgAutomatic), encryptionKey: KEY_POINT })
      )
    );
    expect(keyed.message).toContain('take no encryption key');
  });

  it('retries a DKG process once when the pool is exhausted', async () => {
    let exhausted = 1;
    const { registry, chain, wallet } = setup({
      newProcess: () =>
        exhausted-- > 0 ? revertWith(DKG_APP_MANAGER_ABI, 'PoolExhausted') : [PID.slice(0, 64)],
    });
    chain.onMine = () => ({ status: 1, logs: [createdLog(PID, wallet.address)] });
    const events = await drain(registry.createProcess(params(KeyMode.DkgAutomatic)));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    expect(chain.sent).toHaveLength(1);
    expect(sentDkg(chain, 0)).toEqual([1n, `0x${'00'.repeat(12)}`, 0n, 0n, 0n, 0n, 0n]);
    expect(
      (iface.decodeFunctionData('newProcess', chain.sent[0].data)[8] as Result).toArray()
    ).toEqual([0n, 0n]);
  });

  it('retries only once, and only for a pool or epoch change', async () => {
    const pool = setup({ newProcess: () => revertWith(DKG_APP_MANAGER_ABI, 'PoolExhausted') });
    const twice = failure(await drain(pool.registry.createProcess(params(KeyMode.DkgAutomatic))));
    expect(twice.revertName).toBe('PoolExhausted');
    expect(simulations(pool.chain)).toHaveLength(2);

    const other = setup({ newProcess: () => revertWith(PROCESS_REGISTRY_ABI, 'InvalidDuration') });
    const once = failure(await drain(other.registry.createProcess(params(KeyMode.DkgAutomatic))));
    expect(once.revertName).toBe('InvalidDuration');
    expect(simulations(other.chain)).toHaveLength(1);
  });

  it('retries after a mined PoolExhausted with a second transaction', async () => {
    let phase: 'first' | 'mined' | 'second' = 'first';
    const { registry, chain, wallet } = setup({
      newProcess: () => {
        if (phase !== 'mined') return [PID.slice(0, 64)];
        // The replay names the mined revert; the pool refills for the retry.
        phase = 'second';
        return revertWith(DKG_APP_MANAGER_ABI, 'PoolExhausted');
      },
    });
    chain.onMine = () => {
      if (phase === 'first') {
        phase = 'mined';
        return { status: 0 };
      }
      return { status: 1, logs: [createdLog(PID, wallet.address)] };
    };
    const events = await drain(registry.createProcess(params(KeyMode.DkgAutomatic)));
    expect(events.map(e => e.status)).toEqual([
      TxStatus.Pending,
      TxStatus.Pending,
      TxStatus.Completed,
    ]);
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1].nonce).toBe(1);
    expect((events[0] as { hash: string }).hash).not.toBe((events[1] as { hash: string }).hash);
  });

  it('draws a fresh organizer key when the registration epoch moved, and returns it', async () => {
    const epochs = [`0x${'0e'.repeat(12)}`, `0x${'0f'.repeat(12)}`];
    let live = 0;
    const { registry, chain, wallet } = setup({
      newProcess: args => {
        const epoch = (args[9] as Result)[1] as string;
        if (epoch === epochs[0]) {
          live = 1; // a new epoch went live under the first attempt
          return revertWith(DKG_APP_MANAGER_ABI, 'InvalidEpoch');
        }
        return [PID.slice(0, 64)];
      },
    });
    chain.contract(ADAPTER, DAVINCI_DKG_ADAPTER_ABI, {
      registrationEpoch: () => [epochs[live]],
      registry: () => [REGISTRY],
    });
    chain.onMine = () => ({ status: 1, logs: [createdLog(PID, wallet.address)] });
    const events = await drain(registry.createProcess(params(KeyMode.DkgLocked)));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    const secret = (events[1] as { response: { organizerSecret: bigint } }).response
      .organizerSecret;
    expect(typeof secret).toBe('bigint');
    const dkg = sentDkg(chain, 0);
    expect(dkg[0]).toBe(2n);
    expect(dkg[1]).toBe(epochs[1]);
    const pk = pointToReducedTE(bjjMulBase(secret));
    expect([dkg[2], dkg[3]]).toEqual([pk.x, pk.y]);

    // An automatic process does not retry on an epoch change alone.
    live = 0;
    const auto = setup({ newProcess: () => revertWith(DKG_APP_MANAGER_ABI, 'InvalidEpoch') });
    await drain(auto.registry.createProcess(params(KeyMode.DkgAutomatic)));
    expect(simulations(auto.chain)).toHaveLength(1);
  });

  it('refuses a DKG mode on a registry without DKG, or a stale id, before sending', async () => {
    const off = setup({ dkgAdapter: () => [ZeroAddress] });
    const disabled = failure(await drain(off.registry.createProcess(params(KeyMode.DkgLocked))));
    expect(disabled).toBeInstanceOf(DkgDisabledError);
    expect(off.chain.sent).toHaveLength(0);

    const next = `0x${'ab'.repeat(20)}f5848002${'00'.repeat(6)}02`;
    const stale = setup({ getNextProcessId: () => [next] });
    for (const mode of [KeyMode.Sequencer, KeyMode.DkgAutomatic, KeyMode.DkgLocked]) {
      const err = failure(await drain(stale.registry.createProcess(params(mode))));
      expect(err.message, String(mode)).toContain(`the registry assigns ${next} next`);
    }
    expect(simulations(stale.chain)).toHaveLength(0);
  });

  it('creates a COUNCIL process bound to its ceremony, without retrying', async () => {
    const { registry, chain, wallet } = setup();
    chain.onMine = () => ({ status: 1, logs: [createdLog(PID, wallet.address)] });
    const events = await drain(
      registry.createProcess({
        ...params(KeyMode.Council),
        ceremonyId: `0x${CID.slice(2).toUpperCase()}`,
      })
    );
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    const done = events[1] as { response: { processId: string; organizerSecret?: bigint } };
    expect(done.response.processId).toBe(PID);
    expect(done.response.organizerSecret).toBeUndefined();
    expect(sentDkg(chain, 0)).toEqual([3n, CID, 0n, 0n, 0n, 0n, 0n]);
    expect(
      (iface.decodeFunctionData('newProcess', chain.sent[0].data)[8] as Result).toArray()
    ).toEqual([0n, 0n]);
    expect(councilParams(CID)).toEqual({
      ...sequencerKeyParams(),
      mode: KeyMode.Council,
      epochId: CID,
    });

    // A binding the manager refuses keeps its name and is not retried.
    const refused = setup({
      newProcess: () => revertWith(COUNCIL_MANAGER_ERRORS_ABI, 'NotAuthorizedCreator'),
    });
    const err = failure(
      await drain(refused.registry.createProcess({ ...params(KeyMode.Council), ceremonyId: CID }))
    );
    expect(err).toBeInstanceOf(ProcessCreateError);
    expect(err.revertName).toBe('NotAuthorizedCreator');
    expect(simulations(refused.chain)).toHaveLength(1);
  });

  it('checks the COUNCIL arguments and the adapter before sending', async () => {
    const { registry, chain } = setup();
    const cases: [Partial<CreateProcessParams>, string][] = [
      [{ keyMode: KeyMode.Council }, 'COUNCIL mode needs the ceremony id'],
      [
        { keyMode: KeyMode.Council, ceremonyId: CID, encryptionKey: KEY_POINT },
        'take no encryption key',
      ],
      [{ keyMode: KeyMode.DkgAutomatic, ceremonyId: CID }, 'only COUNCIL mode takes a ceremony id'],
      [{ keyMode: KeyMode.Sequencer, ceremonyId: CID, encryptionKey: KEY_POINT }, 'only COUNCIL'],
      [{ keyMode: KeyMode.Council, ceremonyId: `0x${'00'.repeat(12)}` }, 'ceremony id is zero'],
      [{ keyMode: KeyMode.Council, ceremonyId: '0x1234' }, 'ceremony id must be 12 bytes'],
      [{ keyMode: 7 as KeyMode }, 'unknown key mode 7'],
    ];
    for (const [override, message] of cases) {
      const err = failure(
        await drain(registry.createProcess({ ...params(KeyMode.Council), ...override }))
      );
      expect(err.message, message).toContain(message);
    }
    expect(chain.sent).toHaveLength(0);

    for (const councilAdapter of [() => [ZeroAddress], undefined]) {
      const off = setup(councilAdapter ? { councilAdapter } : {});
      if (!councilAdapter) {
        off.chain.contract(
          REGISTRY,
          PROCESS_REGISTRY_ABI.filter(f => f.name !== 'councilAdapter'),
          { ...pinsOk, getNextProcessId: () => [PID] }
        );
      }
      const disabled = failure(
        await drain(off.registry.createProcess({ ...params(KeyMode.Council), ceremonyId: CID }))
      );
      expect(disabled).toBeInstanceOf(CouncilDisabledError);
      expect(off.chain.sent).toHaveLength(0);
    }
  });

  it('names the revert of a read the creation needs', async () => {
    const { registry, chain } = setup();
    chain.contract(ADAPTER, DAVINCI_DKG_ADAPTER_ABI, {
      registrationEpoch: () => revertWith(DAVINCI_DKG_ADAPTER_ABI, 'NoLiveEpoch'),
      registry: () => [REGISTRY],
    });
    const err = failure(await drain(registry.createProcess(params(KeyMode.DkgLocked))));
    expect(err).toBeInstanceOf(ProcessCreateError);
    expect(err.revertName).toBe('NoLiveEpoch');
    expect(chain.sent).toHaveLength(0);
  });
});

describe('ProcessRegistryService transaction path', () => {
  it('keeps a transaction whose resend was refused when the chain has it', async () => {
    for (const message of ['already known', 'nonce too low', 'AlreadyKnown', 'Known transaction']) {
      const { registry, chain } = setup();
      chain.broadcastError = { message, keep: true };
      const events = await drain(registry.setProcessStatus(PID, ProcessStatus.ENDED));
      expect(
        events.map(e => e.status),
        message
      ).toEqual([TxStatus.Pending, TxStatus.Completed]);
      expect((events[0] as { hash: string }).hash).toBe(chain.sent[0].hash);
    }
  });

  it('fails a refused broadcast the chain does not know', async () => {
    const { registry, chain } = setup();
    chain.broadcastError = { message: 'nonce too low', keep: false };
    const events = await drain(registry.setProcessStatus(PID, ProcessStatus.ENDED));
    expect(events.map(e => e.status)).toEqual([TxStatus.Failed]);
  });

  it('lets other signers send for themselves', async () => {
    const { chain } = setup();
    const signer = new NonceManager(new Wallet(KEY, chain));
    const registry = new ProcessRegistryService(REGISTRY, signer);
    const events = await drain(registry.setProcessGrace(PID, 150));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);
    expect(iface.decodeFunctionData('setProcessGrace', chain.sent[0].data).toArray()).toEqual([
      PID,
      150n,
    ]);
  });

  it('names a mined revert by replaying it', async () => {
    let mined = false;
    const { registry, chain } = setup({
      finalizeResultsFromDKG: () => (mined ? revertWith(PROCESS_REGISTRY_ABI, 'GraceOpen') : []),
    });
    chain.onMine = () => {
      mined = true;
      return { status: 0 };
    };
    const events = await drain(registry.finalizeResultsFromDKG(PID));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Reverted]);
    const reverted = events[1] as unknown as { reason: string; error: ProcessResultError };
    expect(reverted.reason).toBe('GraceOpen');
    expect(reverted.error).toBeInstanceOf(ProcessResultError);
    expect(reverted.error.revertName).toBe('GraceOpen');

    mined = false;
    await expect(
      SmartContractService.executeTx(registry.finalizeResultsFromDKG(PID))
    ).rejects.toBeInstanceOf(ProcessResultError);
  });

  it('fails writes without a signer', async () => {
    const chain = new MockChain();
    const registry = new ProcessRegistryService(REGISTRY, chain);
    const err = failure(await drain(registry.setProcessStatus(PID, ProcessStatus.CANCELED)));
    expect(err.message).toContain('a signer connected to a provider is required');
  });

  it('sends each organizer write with its arguments and error class', async () => {
    const writes: [
      string,
      (r: ProcessRegistryService) => AsyncGenerator<TxStatusEvent<unknown>>,
      unknown[],
    ][] = [
      ['setProcessStatus', r => r.setProcessStatus(PID, ProcessStatus.PAUSED), [PID, 3n]],
      [
        'setProcessMetadata',
        r => r.setProcessMetadata(PID, 'https://m', `0x${'01'.repeat(32)}`),
        [PID, 'https://m', `0x${'01'.repeat(32)}`],
      ],
      ['setProcessDuration', r => r.setProcessDuration(PID, 7200), [PID, 7200n]],
      ['setProcessMaxVoters', r => r.setProcessMaxVoters(PID, 50n), [PID, 50n]],
      ['setProcessGrace', r => r.setProcessGrace(PID, 600), [PID, 600n]],
      ['revealProcessKey', r => r.revealProcessKey(PID, 42n), [PID, 42n]],
      ['finalizeResultsFromDKG', r => r.finalizeResultsFromDKG(PID), [PID]],
      [
        'setProcessCensus',
        r =>
          r.setProcessCensus(PID, {
            origin: CensusOrigin.OffchainDynamic,
            root: 9n,
            uri: 'https://c',
          }),
        [PID, [2n, zeroPadValue('0x09', 32), ZeroAddress, 'https://c', false]],
      ],
    ];
    for (const [method, write, expected] of writes) {
      const { registry, chain } = setup();
      const events = await drain(write(registry));
      expect(
        events.map(e => e.status),
        method
      ).toEqual([TxStatus.Pending, TxStatus.Completed]);
      const args = iface.decodeFunctionData(method, chain.sent[0].data);
      expect(
        JSON.parse(
          JSON.stringify(args.toArray(true), (_, v: unknown) =>
            typeof v === 'bigint' ? `${v}n` : v
          )
        )
      ).toEqual(
        JSON.parse(
          JSON.stringify(expected, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
        )
      );
    }
  });

  it('uses the right error class per operation', async () => {
    const { registry } = setup({
      setProcessMaxVoters: () => revertWith(PROCESS_REGISTRY_ABI, 'InvalidMaxVoters'),
      setProcessCensus: () => revertWith(PROCESS_REGISTRY_ABI, 'CensusNotUpdatable'),
    });
    const maxVoters = failure(await drain(registry.setProcessMaxVoters(PID, 1)));
    expect(maxVoters).toBeInstanceOf(ProcessMaxVotersError);
    expect(maxVoters.revertName).toBe('InvalidMaxVoters');
    const census = failure(
      await drain(
        registry.setProcessCensus(PID, { origin: CensusOrigin.OffchainDynamic, root: 1n, uri: 'u' })
      )
    );
    expect(census).toBeInstanceOf(CensusNotUpdatable);
  });
});

describe('ProcessRegistryService.closeProcessIn', () => {
  it('ends the process the notice plus the slack after the chain head', async () => {
    const { registry, chain, state } = setup();
    chain.headTime = 1_700_000_500;
    state.process = process({ startTime: 1_700_000_000n, duration: 86_400n });
    // 10 s asked, noticeMin 60 wins, plus the default 45 s slack.
    const events = await drain(registry.closeProcessIn(PID, 10));
    expect(events[events.length - 1]).toEqual({
      status: TxStatus.Completed,
      response: { success: true, duration: 605n },
    });
    expect(iface.decodeFunctionData('setProcessDuration', chain.sent[0].data)[1]).toBe(605n);

    await drain(registry.closeProcessIn(PID, 300, { slack: 6 }));
    expect(iface.decodeFunctionData('setProcessDuration', chain.sent[1].data)[1]).toBe(806n);
  });

  it('refuses to move the end later', async () => {
    const { registry, chain, state } = setup();
    chain.headTime = 1_700_000_500;
    state.process = process({ startTime: 1_700_000_000n, duration: 600n });
    const err = failure(await drain(registry.closeProcessIn(PID, 60)));
    expect(err).toBeInstanceOf(ProcessDurationError);
    expect(err.message).toContain('already ends by then');
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses to close a process before it starts, and bad seconds, before any send', async () => {
    const { registry, chain, state } = setup();
    chain.headTime = 1_700_000_000;
    // Starts tomorrow: the shortened end would come before the start.
    state.process = process({ startTime: 1_700_086_400n, duration: 3600n });
    const early = failure(await drain(registry.closeProcessIn(PID, 60)));
    expect(early).toBeInstanceOf(ProcessDurationError);
    expect(early.message).toBe(
      `closeProcessIn: process ${PID} starts at 2023-11-15T22:13:20.000Z and cannot close ` +
        'before it starts; cancel it, or close it later'
    );
    // An end exactly at the start would be a zero duration: refused too.
    state.process = process({ startTime: 1_700_000_105n, duration: 3600n });
    expect(failure(await drain(registry.closeProcessIn(PID, 60))).message).toContain(
      'cannot close before it starts'
    );
    for (const [seconds, slack] of [
      [-1, undefined],
      [1.5, undefined],
      [Number.NaN, undefined],
      [60, -1],
      [60, 0.5],
    ] as const) {
      const err = failure(await drain(registry.closeProcessIn(PID, seconds, { slack })));
      expect(err).toBeInstanceOf(ProcessDurationError);
      expect(err.message).toContain('is not a whole number of seconds');
    }
    // Starting soon, a close that still falls after the start goes through.
    state.process = process({ startTime: 1_700_000_010n, duration: 3600n });
    await drain(registry.closeProcessIn(PID, 60));
    expect(iface.decodeFunctionData('setProcessDuration', chain.sent[0].data)[1]).toBe(95n);
    expect(chain.sent).toHaveLength(1);
  });

  it('refuses negative durations, starts and caps before encoding them', async () => {
    const { registry, chain } = setup();
    const duration = failure(await drain(registry.setProcessDuration(PID, -5n)));
    expect(duration).toBeInstanceOf(ProcessDurationError);
    expect(duration.message).toBe('setProcessDuration: duration -5 is negative');
    for (const [field, value] of [
      ['startTime', -1],
      ['duration', -3600],
      ['maxVoters', -2n],
    ] as const) {
      const err = failure(await drain(registry.newProcess({ ...baseParams(), [field]: value })));
      expect(err).toBeInstanceOf(ProcessCreateError);
      expect(err.message).toBe(`newProcess: ${field} ${value} is negative`);
    }
    expect(chain.sent).toHaveLength(0);
  });
});

describe('ProcessRegistryService.verifyDeployment', () => {
  const codeHash = keccak256('0x6001600101');

  it('accepts a registry that pins this release', async () => {
    const { registry } = setup();
    expect(await registry.verifyDeployment({ ziskVerifierCodeHash: codeHash })).toEqual({
      chainId: 100n,
      verifier: VERIFIER,
      dkgAdapter: ADAPTER,
      councilAdapter: COUNCIL_ADAPTER,
    });
    // The release's own verifier code hash is not the mock's code.
    await expect(registry.verifyDeployment()).rejects.toMatchObject({
      field: 'verifier code hash',
      expected: RELEASE_PINS.ziskVerifierCodeHash,
      got: codeHash,
    });
  });

  it('reports the first pin that differs', async () => {
    const other = `0x${'99'.repeat(32)}`;
    const wrong: [string, Record<string, CallHandler>, (c: MockChain) => void][] = [
      ['batchProgramVK', { batchProgramVK: () => [other] }, () => undefined],
      ['resultsProgramVK', { resultsProgramVK: () => [other] }, () => undefined],
      ['rootCVadcopFinal', { rootCVadcopFinal: () => [other] }, () => undefined],
      ['ballotVKHash', { ballotVKHash: () => [other] }, () => undefined],
      ['chainID', { chainID: () => [10200] }, () => undefined],
      ['verifier code hash', {}, c => c.setCode(VERIFIER, '0x6001')],
      [
        'verifier rootCVadcopFinal',
        {},
        c => c.contract(VERIFIER, ZISK_VERIFIER_ABI, { getRootCVadcopFinal: () => [other] }),
      ],
      [
        'dkgAdapter.registry',
        {},
        c =>
          c.contract(ADAPTER, DAVINCI_DKG_ADAPTER_ABI, {
            registry: () => ['0x' + '01'.repeat(20)],
          }),
      ],
      [
        'councilAdapter.registry',
        {},
        c =>
          c.contract(COUNCIL_ADAPTER, COUNCIL_ADAPTER_ABI, {
            registry: () => ['0x' + '01'.repeat(20)],
          }),
      ],
    ];
    for (const [pin, calls, tweak] of wrong) {
      const { registry, chain } = setup(calls);
      chain.setCode(VERIFIER, '0x6001600101');
      tweak(chain);
      const err = (await registry
        .verifyDeployment({ ziskVerifierCodeHash: codeHash })
        .catch((e: unknown) => e)) as DeploymentPinError;
      expect(err, pin).toBeInstanceOf(DeploymentPinError);
      expect(err.field).toBe(pin);
    }
    const { registry } = setup({
      dkgAdapter: () => [ZeroAddress],
      councilAdapter: () => [ZeroAddress],
    });
    const info = await registry.verifyDeployment({ ziskVerifierCodeHash: codeHash });
    expect(info.dkgAdapter).toBeNull();
    expect(info.councilAdapter).toBeNull();
  });

  it('accepts a registry from before the COUNCIL mode, and fails on an unreadable one', async () => {
    const before = setup();
    before.chain.contract(
      REGISTRY,
      PROCESS_REGISTRY_ABI.filter(f => f.name !== 'councilAdapter'),
      pinsOk
    );
    const info = await before.registry.verifyDeployment({ ziskVerifierCodeHash: codeHash });
    expect(info.councilAdapter).toBeNull();
    expect(info.dkgAdapter).toBe(ADAPTER);

    const broken = setup({
      councilAdapter: () => revertWith(PROCESS_REGISTRY_ABI, 'Unauthorized'),
    });
    await expect(
      broken.registry.verifyDeployment({ ziskVerifierCodeHash: codeHash })
    ).rejects.toThrow();
  });
});

describe('registry events', () => {
  it('decodes every event of the registry', () => {
    const creator = getAddress('0x' + '0a'.repeat(20));
    const cases: [string, unknown[], Record<string, unknown>][] = [
      ['ProcessCreated', [PID, creator], { creator }],
      ['ProcessStatusChanged', [PID, 0, 4], { oldStatus: 0, newStatus: 4 }],
      [
        'CensusUpdated',
        [PID, `0x${'05'.repeat(32)}`, 'https://c'],
        { censusRoot: `0x${'05'.repeat(32)}`, censusUri: 'https://c' },
      ],
      [
        'ProcessMetadataUpdated',
        [PID, 'https://m', `0x${'06'.repeat(32)}`],
        { metadataUri: 'https://m', metadataHash: `0x${'06'.repeat(32)}` },
      ],
      ['ProcessDurationChanged', [PID, 600], { duration: 600n }],
      ['ProcessMaxVotersChanged', [PID, 50], { maxVoters: 50n }],
      ['ProcessGraceChanged', [PID, 150], { grace: 150 }],
      [
        'ProcessStateTransitioned',
        [PID, creator, `0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`, 5, 1, 2],
        {
          sender: creator,
          oldStateRoot: `0x${'01'.repeat(32)}`,
          newStateRoot: `0x${'02'.repeat(32)}`,
          votersCount: 5n,
          overwrittenVotesCount: 1n,
          nBlobs: 2n,
        },
      ],
      ['ProcessResultsSet', [PID, creator, [3, 0]], { sender: creator, result: [3n, 0n] }],
      [
        'ResultsDecryptionRequested',
        [PID, `0x${'0e'.repeat(12)}`, `0x${'0d'.repeat(32)}`, 12, 3],
        { epochId: `0x${'0e'.repeat(12)}`, aid: `0x${'0d'.repeat(32)}`, firstIndex: 12, count: 3 },
      ],
    ];
    expect(cases).toHaveLength(iface.fragments.filter(f => f.type === 'event').length);
    for (const [name, args, fields] of cases) {
      const { topics, data } = iface.encodeEventLog(name, args);
      const log = {
        topics,
        data,
        address: REGISTRY,
        blockNumber: 9,
        transactionHash: '0xab',
        index: 2,
      };
      expect(parseRegistryLog(log), name).toEqual({
        name,
        processId: PID,
        blockNumber: 9,
        transactionHash: '0xab',
        logIndex: 2,
        ...fields,
      });
    }
    const other = new Interface(['event Transfer(address indexed a, uint256 b)']);
    const foreign = other.encodeEventLog('Transfer', [creator, 1]);
    expect(parseRegistryLog({ ...foreign })).toBeNull();
    const created = iface.encodeEventLog('ProcessCreated', [PID, creator]);
    expect(
      parseRegistryLogs(
        [
          { ...created, address: VERIFIER },
          { ...created, address: REGISTRY.toLowerCase() },
        ],
        REGISTRY
      )
    ).toHaveLength(1);
  });

  it('calls listeners with the event arguments only', () => {
    // What ethers v6 `contract.on` passes: the decoded arguments, then the event payload.
    class Probe extends ProcessRegistryService {
      listener<Args extends unknown[]>(cb: (...args: Args) => void) {
        return this.normalizeListener(cb);
      }
    }
    const probe = new Probe(REGISTRY, new MockChain());
    const contract = new Contract(REGISTRY, PROCESS_REGISTRY_ABI);
    const fragment = iface.getEvent('ProcessStatusChanged');
    if (!fragment) throw new Error('no ProcessStatusChanged in the ABI');
    const { topics, data } = iface.encodeEventLog(fragment, [PID, 0, 3]);
    const log = new Log(
      {
        topics,
        data,
        address: REGISTRY,
        blockNumber: 9,
        blockHash: `0x${'01'.repeat(32)}`,
        transactionHash: `0x${'02'.repeat(32)}`,
        transactionIndex: 0,
        index: 0,
        removed: false,
      },
      null as unknown as Provider
    );
    const payload = new ContractEventPayload(contract, null, fragment.name, fragment, log);
    const received: unknown[][] = [];
    const listener = probe.listener((...args: [string, bigint, bigint]) => received.push(args));
    listener(...payload.args, payload);
    listener(PID, 3n, 0n);
    expect(received).toEqual([
      [PID, 0n, 3n],
      [PID, 3n, 0n],
    ]);
  });
});

describe('registry write arguments', () => {
  it('builds the DKG parameters of each key mode', () => {
    expect(sequencerKeyParams()).toEqual({
      mode: KeyMode.Sequencer,
      epochId: `0x${'00'.repeat(12)}`,
      orgPKx: 0n,
      orgPKy: 0n,
      popAx: 0n,
      popAy: 0n,
      popZ: 0n,
    });
    expect(dkgAutomaticParams()).toEqual({ ...sequencerKeyParams(), mode: KeyMode.DkgAutomatic });
    const proof = { pkX: 1n, pkY: 2n, aX: 3n, aY: 4n, z: 5n };
    expect(dkgLockedParams(`0x${'0E'.repeat(12)}`, proof)).toEqual({
      mode: KeyMode.DkgLocked,
      epochId: `0x${'0e'.repeat(12)}`,
      orgPKx: 1n,
      orgPKy: 2n,
      popAx: 3n,
      popAy: 4n,
      popZ: 5n,
    });
    expect(() => dkgLockedParams('0x0e', proof)).toThrow();
  });

  it('hashes metadata as the exact bytes', () => {
    const doc = '{"version":"1.1","title":{"default":"ñ"}}\n';
    expect(metadataHash(doc)).toBe(sha256(toUtf8Bytes(doc)));
    expect(metadataHash(toUtf8Bytes(doc))).toBe(metadataHash(doc));
    expect(metadataHash(doc)).not.toBe(metadataHash(doc.trimEnd()));
  });
});
