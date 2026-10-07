import {
  Interface,
  Wallet,
  ZeroAddress,
  getAddress,
  sha256,
  toUtf8Bytes,
  type Result,
} from 'ethers';
import {
  CensusError,
  CensusOrigin,
  CensusPublishError,
  OffchainCensus,
  OffchainDynamicCensus,
  OnchainCensus,
  PublishedCensus,
} from '../../../src/census';
import {
  CensusNotUpdatable,
  CouncilDisabledError,
  ContractServiceError,
  DAVINCI_DKG_ADAPTER_ABI,
  DKG_APP_MANAGER_ABI,
  DkgDisabledError,
  KeyMode,
  ONCHAIN_CENSUS_ABI,
  PROCESS_REGISTRY_ABI,
  ProcessCensusError,
  ProcessCreateError,
  ProcessDurationError,
  ProcessGraceError,
  ProcessKeyRevealError,
  ProcessMaxVotersError,
  ProcessMetadataError,
  ProcessRegistryService,
  ProcessStatus,
  ProcessStatusError,
  TxStatus,
  WrongProcessIdError,
  type TxStatusEvent,
} from '../../../src/contracts';
import { VocdoniApiService } from '../../../src/core/api/ApiService';
import { SequencerDecodeError } from '../../../src/sequencer';
import {
  ProcessOrchestrationService,
  buildElectionMetadata,
  serializeMetadata,
  type ProcessConfig,
  type QuestionConfig,
} from '../../../src/core';
import {
  BJJ_SUBGROUP_ORDER,
  BN254_FR,
  bjjMulBase,
  pointToReducedTE,
  slotFromAddress,
} from '../../../src/crypto';
import { GNOSIS, computeProcessId } from '../../../src/networks';
import { DocumentHost } from '../../helpers/documentHost';
import { MockChain, revertWith, type CallHandler } from '../../helpers/mockChain';

const REGISTRY = GNOSIS.processRegistry;
const ADAPTER = '0xE9559c78E7ff8c19937A0657a092A221E90CCBC3';
const KEY = `0x${'11'.repeat(32)}`;
const ORGANIZER = new Wallet(KEY).address;
const PREFIX = '0x83f2e36e';
const pidOf = (nonce: number, creator = ORGANIZER) => computeProcessId(creator, PREFIX, nonce);
const PID = pidOf(0);
const KEY_NODE = 'https://key.sequencer.test';
const KEY_POINT = bjjMulBase(12345n);
const CONTRACT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const EPOCH = `0x${'0e'.repeat(12)}`;
const AID = `0x${'0d'.repeat(32)}`;
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
/** MockChain's head block time. */
const NOW = 1_700_000_000;
const iface = new Interface(PROCESS_REGISTRY_ABI);

const questions: [QuestionConfig] = [
  {
    title: 'Which site?',
    choices: [
      { title: 'North', value: 0 },
      { title: 'South', value: 1 },
    ],
  },
];

const ballot = {
  numFields: 2,
  maxValue: '1',
  minValue: '0',
  uniqueValues: false,
  costExponent: 1,
  maxValueSum: '1',
  minValueSum: '0',
};

const timing = { startDate: NOW + 60, duration: 3600 };

type Process = Record<string, unknown>;

// A READY sequencer-key process of `organizer`, open at NOW until NOW + 3500.
function onchainProcess(organizer: string, overrides: Process = {}): Process {
  return {
    status: 0,
    organizationId: organizer,
    encryptionKey: { x: KEY_POINT.x, y: KEY_POINT.y },
    latestStateRoot: `0x${'04'.repeat(32)}`,
    result: [],
    startTime: BigInt(NOW - 100),
    duration: 3600n,
    maxVoters: 100n,
    votersCount: 0n,
    overwrittenVotesCount: 0n,
    creationBlock: 48_600_000n,
    batchNumber: 0n,
    metadataURI: '',
    metadataHash: `0x${'aa'.repeat(32)}`,
    ballotMode: {
      uniqueValues: false,
      numFields: 2,
      groupSize: 2,
      costExponent: 1,
      maxValue: 1n,
      minValue: 0n,
      maxValueSum: 1n,
      minValueSum: 0n,
    },
    census: {
      censusOrigin: 2,
      censusRoot: `0x${'00'.repeat(31)}05`,
      contractAddress: ZeroAddress,
      censusURI: 'https://files.example.org/c0.json',
      onchainAllowAnyValidRoot: false,
    },
    keyMode: 0,
    dkgEpochId: `0x${'00'.repeat(12)}`,
    dkgFirstIndex: 0,
    dkgCount: 0,
    dkgZeroSkipped: 0,
    dkgResultsRequested: false,
    dkgAid: `0x${'00'.repeat(32)}`,
    grace: 180,
    lastVoteAt: 0n,
    ...overrides,
  };
}

interface SetupOptions {
  uploader?: boolean;
  verify?: boolean;
  calls?: Record<string, CallHandler>;
}

function setup(options: SetupOptions = {}) {
  const chain = new MockChain();
  chain.headTime = NOW;
  const wallet = new Wallet(KEY, chain);
  const timeline: string[] = [];
  const state = {
    process: onchainProcess(wallet.address),
    byId: new Map<string, Process>(),
    nonce: 0,
    adapter: ADAPTER,
    // The id the next ProcessCreated names instead of the assigned one.
    createdId: undefined as string | undefined,
    keyNodeDown: false,
    keyPoint: KEY_POINT,
    graceEnd: BigInt(NOW + 3680),
  };
  chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, {
    getNextProcessId: args => [pidOf(state.nonce, args[0] as string)],
    getProcess: args => [state.byId.get(args[0] as string) ?? state.process],
    newProcess: () => [pidOf(state.nonce)],
    setProcessStatus: () => [],
    setProcessCensus: () => [],
    setProcessMetadata: () => [],
    setProcessDuration: () => [],
    setProcessGrace: () => [],
    setProcessMaxVoters: () => [],
    revealProcessKey: () => [],
    defaultGrace: () => [180],
    graceFloor: () => [150],
    graceCeil: () => [600],
    graceMaxTotal: () => [1800],
    noticeMin: () => [60],
    getProcessGraceEnd: () => [state.graceEnd],
    dkgAdapter: () => [state.adapter],
    aidFor: () => [AID],
    processNonce: () => [BigInt(state.nonce)],
    pidPrefix: () => [Number(PREFIX)],
    ...options.calls,
  });
  chain.contract(ADAPTER, DAVINCI_DKG_ADAPTER_ABI, { registrationEpoch: () => [EPOCH] });
  chain.onMine = tx => {
    const parsed = iface.parseTransaction({ data: tx.data });
    timeline.push(`mined:${parsed?.name}`);
    if (parsed?.name !== 'newProcess') return { status: 1 };
    const pid = state.createdId ?? pidOf(state.nonce, tx.from as string);
    state.createdId = undefined;
    state.nonce++;
    const { topics, data } = iface.encodeEventLog('ProcessCreated', [pid, tx.from]);
    return { status: 1, logs: [{ address: REGISTRY, topics, data }] };
  };
  const keyRequests: string[] = [];
  const keyFetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (state.keyNodeDown) return Promise.reject(new TypeError('fetch failed'));
    const { processId } = JSON.parse(String(init?.body)) as { processId: string };
    keyRequests.push(processId);
    timeline.push(`key:${processId}`);
    const key = state.keyPoint;
    const body = JSON.stringify({ x: key.x.toString(), y: key.y.toString() });
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
  const api = new VocdoniApiService({
    keySequencerURL: KEY_NODE,
    sequencerConfig: { fetchImpl: keyFetch },
  });
  const host = new DocumentHost();
  const registry = new ProcessRegistryService(REGISTRY, wallet, { receiptTimeoutMs: 2000 });
  const orchestrator = new ProcessOrchestrationService(registry, api, wallet, {
    ...(options.uploader !== false && { uploader: host.uploader }),
    documents: { fetchImpl: host.fetchImpl, verify: options.verify },
  });
  const sent = () =>
    chain.sent.map(tx => iface.parseTransaction({ data: tx.data })).filter(p => p !== null);
  return { chain, wallet, state, host, orchestrator, keyRequests, sent, timeline, registry, api };
}

const census = (args: Result) => args.getValue('census') as Result;
const dkgOf = (args: Result): unknown[] => [...(args.getValue('dkg') as Result)];

// The error a promise rejects with.
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error
  );

// Expects a typed refusal naming the registry error.
async function refusal(
  p: Promise<unknown>,
  ErrorType: abstract new (...args: never[]) => ContractServiceError,
  revertName: string | undefined,
  message: string
) {
  const err = (await errorOf(p)) as ContractServiceError;
  expect(err).toBeInstanceOf(ErrorType);
  expect(err.revertName).toBe(revertName);
  expect(err.message).toContain(message);
}

async function collect<T>(stream: AsyncGenerator<TxStatusEvent<T>>): Promise<TxStatusEvent<T>[]> {
  const events: TxStatusEvent<T>[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

const members = (...keys: (string | { key: string; weight: string | bigint })[]) => {
  const c = new OffchainCensus();
  c.add(keys);
  return c;
};

describe('ProcessOrchestrationService.createProcess', () => {
  it('publishes the census and the metadata, then creates the process with them', async () => {
    const { host, orchestrator, keyRequests, sent } = setup();
    const merkle = members(A, { key: B, weight: '3' });
    const result = await orchestrator.createProcess({
      title: { default: 'Parks', es: 'Parques' },
      description: 'Pick one',
      census: merkle,
      electionPreset: { type: 'single_choice' },
      timing,
      questions,
    });
    expect(result).toEqual({ processId: PID, transactionHash: expect.any(String) as string });

    const metadata = serializeMetadata(
      buildElectionMetadata({
        title: { default: 'Parks', es: 'Parques' },
        description: 'Pick one',
        questions,
        electionPreset: { type: 'single_choice' },
      })
    );
    expect(host.uploads.map(u => u.kind)).toEqual(['census', 'metadata']);
    expect(host.uploads[0].data).toEqual(merkle.serialize());
    expect(host.uploads[1].data).toEqual(metadata);
    // The key is asked for the id the registry assigns next.
    expect(keyRequests).toEqual([PID]);

    const [create] = sent();
    expect(create.name).toBe('newProcess');
    expect(create.args.getValue('status')).toBe(0n);
    expect(create.args.getValue('startTime')).toBe(BigInt(NOW + 60));
    expect(create.args.getValue('duration')).toBe(3600n);
    expect(create.args.getValue('maxVoters')).toBe(2n);
    expect([...census(create.args)]).toEqual([
      1n,
      await merkle.root(),
      ZeroAddress,
      host.urlOf(merkle.serialize()),
      false,
    ]);
    expect(create.args.getValue('metadataURI')).toBe(host.urlOf(metadata));
    expect(create.args.getValue('metadataHash')).toBe(sha256(metadata));
    expect([...(create.args.getValue('encryptionKey') as Result)]).toEqual([
      KEY_POINT.x,
      KEY_POINT.y,
    ]);
    expect(dkgOf(create.args)).toEqual([0n, `0x${'00'.repeat(12)}`, 0n, 0n, 0n, 0n, 0n]);
  });

  it('needs an uploader for a census object or the metadata fields, and sends nothing without one', async () => {
    const { orchestrator, chain, keyRequests } = setup({ uploader: false });
    await expect(
      orchestrator.createProcess({ title: 't', census: members(A), ballot, timing, questions })
    ).rejects.toThrow('publishing the census file needs an uploader');
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    await expect(
      orchestrator.createProcess({
        title: 't',
        census: csp,
        ballot,
        timing,
        questions,
        maxVoters: 5,
      })
    ).rejects.toThrow('publishing the metadata document needs an uploader');
    expect(chain.sent).toHaveLength(0);
    expect(keyRequests).toHaveLength(0);
  });

  it('takes a metadata URL with its hash, or hashes what it serves', async () => {
    const { host, orchestrator, sent } = setup();
    const doc = toUtf8Bytes('{"title":{"default":"served"}}');
    const url = 'https://files.example.org/meta.json';
    host.serve(url, { body: doc });
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const base = { census: csp, ballot, timing, maxVoters: 5, metadataUri: url };
    await orchestrator.createProcess(base);
    await orchestrator.createProcess({ ...base, metadataHash: `0x${'CD'.repeat(32)}` });
    const [fetched, given] = sent();
    expect(fetched.args.getValue('metadataHash')).toBe(sha256(doc));
    expect(given.args.getValue('metadataHash')).toBe(`0x${'cd'.repeat(32)}`);
    expect(host.uploads).toHaveLength(0);
    await expect(
      orchestrator.createProcess({ ...base, metadataHash: `0x${'00'.repeat(32)}` })
    ).rejects.toThrow('not a non-zero 32-byte hex hash');
    // A metadata URL to hash is read under the URL policy.
    const internal = 'http://10.0.0.5/meta.json';
    host.serve(internal, { body: doc });
    await expect(orchestrator.createProcess({ ...base, metadataUri: internal })).rejects.toThrow(
      `refused the metadata at ${internal}`
    );
    expect(host.fetches.map(f => f.url)).not.toContain(internal);
  });

  it('checks a Merkle census URL given by hand before asking for a key', async () => {
    const { host, orchestrator, keyRequests } = setup();
    const merkle = members(A, B);
    const url = 'https://census.example.org/c.json';
    host.serve(url, { body: merkle.serialize() });
    const doc = buildElectionMetadata({ title: 't', questions });
    const config = (root: string): ProcessConfig => ({
      title: 't',
      census: { type: CensusOrigin.OffchainStatic, root, uri: url },
      ballot,
      timing,
      questions,
      maxVoters: 2,
    });
    await expect(orchestrator.createProcess(config(`0x${'05'.padStart(64, '0')}`))).rejects.toThrow(
      CensusPublishError
    );
    expect(keyRequests).toHaveLength(0);
    await orchestrator.createProcess(config(await merkle.root()));
    expect(host.uploads.map(u => u.data)).toEqual([serializeMetadata(doc)]);
    // A published census object is checked the same way; verify: false skips it.
    await expect(
      orchestrator.createProcess({
        ...config(''),
        census: new PublishedCensus(CensusOrigin.OffchainStatic, 7n, url),
      })
    ).rejects.toThrow('serves a census with root');
    const lenient = setup({ verify: false });
    await lenient.orchestrator.createProcess({
      ...config(''),
      census: new PublishedCensus(CensusOrigin.OffchainStatic, 7n, url),
    });
  });

  it('checks an on-chain census is a davinci-zkvm census contract', async () => {
    const { chain, orchestrator, sent } = setup();
    chain.contract(CONTRACT, ONCHAIN_CENSUS_ABI, {
      getCensusRoot: () => [9n],
      treeSize: () => [3n],
      slotOf: args => [slotFromAddress(args[0] as string)],
    });
    const base = { title: 't', ballot, timing, questions, maxVoters: 3 };
    await orchestrator.createProcess({ ...base, census: new OnchainCensus(CONTRACT) });
    expect([...census(sent()[0].args)]).toEqual([
      3n,
      `0x${'00'.repeat(32)}`,
      getAddress(CONTRACT),
      `onchain://${getAddress(CONTRACT)}`,
      false,
    ]);
    const missing = '0x4444444444444444444444444444444444444444';
    await expect(
      orchestrator.createProcess({ ...base, census: new OnchainCensus(missing) })
    ).rejects.toThrow(`no contract at ${getAddress(missing)}`);
    await expect(
      orchestrator.createProcess({
        ...base,
        census: new OnchainCensus(CONTRACT),
        maxVoters: undefined,
      })
    ).rejects.toThrow('maxVoters is required');
  });

  it('times the process on the chain clock; no start means the creating block', async () => {
    const { orchestrator, sent } = setup();
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const create = (t: ProcessConfig['timing']) =>
      orchestrator.createProcess({
        title: 't',
        census: csp,
        ballot,
        questions,
        maxVoters: 5,
        timing: t,
      });
    await create({ duration: 3600 });
    await create({ startDate: 0, duration: 60 });
    // An end with no start runs from the chain head.
    await create({ endDate: NOW + 7200 });
    await create({
      startDate: new Date((NOW + 100) * 1000),
      endDate: `${new Date((NOW + 3700) * 1000).toISOString()}`,
    });
    await create({ startDate: (NOW + 100) * 1000, duration: 5 });
    const times = sent().map(t => [
      t.args.getValue('startTime') as bigint,
      t.args.getValue('duration') as bigint,
    ]);
    expect(times).toEqual([
      [0n, 3600n],
      [0n, 60n],
      [0n, 7200n],
      [BigInt(NOW + 100), 3600n],
      [BigInt(NOW + 100), 5n],
    ]);
  });

  it('refuses times the registry refuses, before any upload', async () => {
    const { orchestrator, host, chain, keyRequests } = setup();
    const create = (t: ProcessConfig['timing']) =>
      orchestrator.createProcess({ title: 't', census: members(A), ballot, questions, timing: t });
    await refusal(
      create({ startDate: NOW, duration: 60 }),
      ProcessCreateError,
      'InvalidStartTime',
      'is not after the chain time 2023-11-14T22:13:20.000Z; omit it to start when the transaction lands'
    );
    await refusal(
      create({ startDate: NOW - 3600, duration: 7200 }),
      ProcessCreateError,
      'InvalidStartTime',
      'startDate'
    );
    await refusal(
      create({ endDate: NOW }),
      ProcessCreateError,
      'InvalidDuration',
      'End date must be after start date'
    );
    await refusal(
      create({ startDate: NOW + 100, endDate: NOW + 100 }),
      ProcessCreateError,
      'InvalidDuration',
      'End date must be after start date'
    );
    for (const duration of [0, -5, 1.5, Number.NaN]) {
      await refusal(
        create({ duration }),
        ProcessCreateError,
        undefined,
        'is not a positive number of seconds'
      );
    }
    await expect(create({ duration: 60, endDate: NOW + 60 })).rejects.toThrow(
      "Cannot specify both 'duration' and 'endDate'"
    );
    await expect(create({})).rejects.toThrow("Must specify either 'duration'");
    await expect(create({ startDate: 'tomorrow', duration: 60 })).rejects.toThrow(
      'Invalid date string'
    );
    expect(host.uploads).toHaveLength(0);
    expect(keyRequests).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses a ballot mode, max voters or a result cap the registry refuses, before any upload', async () => {
    const { orchestrator, host, chain } = setup();
    const create = (config: Partial<ProcessConfig>) =>
      orchestrator.createProcess({
        title: 't',
        census: members(A),
        ballot,
        timing,
        questions,
        ...config,
      } as ProcessConfig);
    await refusal(
      create({ ballot: { ...ballot, numFields: 17 } }),
      ProcessCreateError,
      'InvalidMaxCount',
      'numFields 17 is not in 1..16'
    );
    await refusal(
      create({ ballot: { ...ballot, groupSize: 3 } }),
      ProcessCreateError,
      'InvalidGroupSize',
      'groupSize 3 exceeds'
    );
    await refusal(
      create({ ballot: { ...ballot, minValue: '2' } }),
      ProcessCreateError,
      'InvalidMaxMinValueBounds',
      'minValue 2 exceeds'
    );
    await refusal(
      create({ ballot: { ...ballot, maxValue: String(2 ** 48) } }),
      ProcessCreateError,
      'BallotModeMaxValueTooLarge',
      'does not fit in 48 bits'
    );
    await refusal(
      create({ ballot: { ...ballot, minValueSum: '2' } }),
      ProcessCreateError,
      'InvalidValueSumBounds',
      'minValueSum 2 exceeds'
    );
    const many = [
      { title: 'q', choices: Array.from({ length: 17 }, (_, i) => ({ title: `${i}`, value: i })) },
    ];
    await refusal(
      create({
        ballot: undefined,
        electionPreset: { type: 'approval' },
        questions: many as unknown as [QuestionConfig],
      }),
      ProcessCreateError,
      'InvalidMaxCount',
      'questions[0] has 17 choices'
    );
    await refusal(
      create({ maxVoters: 0 }),
      ProcessCreateError,
      'InvalidMaxVoters',
      'maxVoters 0 is not a positive integer'
    );
    await refusal(
      create({ maxVoters: 2.5 }),
      ProcessCreateError,
      'InvalidMaxVoters',
      'maxVoters 2.5'
    );
    // maxValue may not exceed floor(1e12 / maxVoters).
    await refusal(
      create({
        ballot: { ...ballot, maxValue: '1000000', maxValueSum: '1000000' },
        maxVoters: 1_000_001,
      }),
      ProcessCreateError,
      'MaxPossibleResultCapExceeded',
      "maxValue 1000000 with 1000001 voters exceeds the registry's result cap of 1000000000000: at most 999999 per field"
    );
    await expect(create({ ballot: undefined })).rejects.toThrow(
      'Either ballot or electionPreset is required'
    );
    await expect(create({ electionPreset: { type: 'approval' } })).rejects.toThrow('not both');
    await expect(create({ census: new OffchainCensus() })).rejects.toThrow(
      'the census has no members'
    );
    expect(host.uploads).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
    // At the cap exactly, it goes through.
    await create({
      ballot: { ...ballot, maxValue: '1000000', maxValueSum: '1000000' },
      maxVoters: 1_000_000,
    });
    expect(chain.sent).toHaveLength(1);
  });

  it('keeps census weights provable when the weight is the budget', async () => {
    const { orchestrator, host, chain } = setup();
    const weighted = { ...ballot, maxValue: '1000', maxValueSum: '0' };
    const heavy = members(A, { key: B, weight: (1n << 63n).toString() });
    await refusal(
      orchestrator.createProcess({
        title: 't',
        census: heavy,
        ballot: weighted,
        timing,
        questions,
      }),
      ProcessCreateError,
      undefined,
      `${B} has weight 9223372036854775808: with maxValueSum 0 the weight is the voter's budget`
    );
    expect(host.uploads).toHaveLength(0);
    const fits = members(A, { key: B, weight: ((1n << 63n) - 1n).toString() });
    await orchestrator.createProcess({
      title: 't',
      census: fits,
      ballot: weighted,
      timing,
      questions,
    });
    // With a fixed budget the weight is not compared.
    await orchestrator.createProcess({ title: 't', census: heavy, ballot, timing, questions });
    expect(chain.sent).toHaveLength(2);
  });

  it('refuses a sequencer key that is not a prime-order point, sending nothing', async () => {
    const { orchestrator, state, chain, keyRequests } = setup();
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };
    // The identity, and the order-2 point (0, -1): on the curve, outside the subgroup.
    for (const bad of [
      { x: 0n, y: 1n },
      { x: 0n, y: BN254_FR - 1n },
    ]) {
      state.keyPoint = bad;
      const err = await errorOf(orchestrator.createProcess(config));
      expect(err).toBeInstanceOf(SequencerDecodeError);
      expect(err?.message).toContain('encryption key is not a prime-order point');
    }
    expect(keyRequests).toEqual([PID, PID]);
    expect(chain.sent).toHaveLength(0);
  });

  it('fails a sequencer-key process created under another id, and remembers it', async () => {
    const { orchestrator, state, keyRequests, sent } = setup();
    state.createdId = pidOf(5);
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };
    const events = await collect(orchestrator.createProcessStream(config));
    expect(events.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Failed]);
    const err = (events[1] as { error: unknown }).error as WrongProcessIdError;
    expect(err).toBeInstanceOf(WrongProcessIdError);
    expect([err.created, err.expected]).toEqual([pidOf(5), PID]);
    expect(orchestrator.createdProcesses).toEqual([pidOf(5)]);
    expect(keyRequests).toEqual([PID]);
    // The next creation is keyed for the id after it.
    await orchestrator.createProcess(config);
    expect(keyRequests).toEqual([PID, pidOf(1)]);
    expect(orchestrator.createdProcesses).toEqual([pidOf(5), pidOf(1)]);
    expect(sent()).toHaveLength(2);
  });

  it('creates DKG processes without a sequencer key', async () => {
    const { orchestrator, keyRequests, sent } = setup();
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };
    const auto = await orchestrator.createProcess({ ...config, keyMode: 'dkg' });
    expect(auto).toEqual({ processId: PID, transactionHash: expect.any(String) as string });
    const locked = await orchestrator.createProcess({ ...config, keyMode: 'dkg-locked' });
    const enumLocked = await orchestrator.createProcess({ ...config, keyMode: KeyMode.DkgLocked });
    expect(keyRequests).toHaveLength(0);

    const [a, l, e] = sent();
    expect([...(a.args.getValue('encryptionKey') as Result)]).toEqual([0n, 0n]);
    expect(dkgOf(a.args)).toEqual([1n, `0x${'00'.repeat(12)}`, 0n, 0n, 0n, 0n, 0n]);
    // The secret the organizer keeps is the one the proof commits to.
    const secret = locked.organizerSecret as bigint;
    expect(secret > 0n && secret < BJJ_SUBGROUP_ORDER).toBe(true);
    const pk = pointToReducedTE(bjjMulBase(secret));
    expect(dkgOf(l.args).slice(0, 4)).toEqual([2n, EPOCH, pk.x, pk.y]);
    expect(locked.processId).toBe(pidOf(1));
    expect(enumLocked.organizerSecret).not.toBe(secret);
    expect(dkgOf(e.args)[0]).toBe(2n);
  });

  it('refuses a DKG key on a registry without DKG before any upload', async () => {
    const { orchestrator, state, host, chain } = setup();
    state.adapter = ZeroAddress;
    const config = { title: 't', census: members(A), ballot, timing, questions };
    for (const keyMode of ['dkg', 'dkg-locked'] as const) {
      const err = await errorOf(orchestrator.createProcess({ ...config, keyMode }));
      expect(err).toBeInstanceOf(DkgDisabledError);
    }
    await expect(
      orchestrator.createProcess({ ...config, keyMode: 'committee' as 'dkg' })
    ).rejects.toThrow('unknown key mode committee');
    expect(host.uploads).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it('creates COUNCIL processes bound to their ceremony', async () => {
    const cid = `0x${'c1'.repeat(12)}`;
    const adapter = getAddress(`0x${'c0'.repeat(20)}`);
    const { orchestrator, keyRequests, sent } = setup({
      calls: { councilAdapter: () => [adapter] },
    });
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };
    const named = await orchestrator.createProcess({
      ...config,
      keyMode: 'council',
      ceremonyId: cid,
    });
    expect(named).toEqual({ processId: PID, transactionHash: expect.any(String) as string });
    await orchestrator.createProcess({ ...config, keyMode: KeyMode.Council, ceremonyId: cid });
    expect(keyRequests).toHaveLength(0);

    const [n, e] = sent();
    expect([...(n.args.getValue('encryptionKey') as Result)]).toEqual([0n, 0n]);
    expect(dkgOf(n.args)).toEqual([3n, cid, 0n, 0n, 0n, 0n, 0n]);
    expect(dkgOf(e.args)[0]).toBe(3n);
  });

  it('refuses a COUNCIL key without a ceremony or Council before any upload', async () => {
    const cid = `0x${'c1'.repeat(12)}`;
    const { orchestrator, host, chain } = setup({
      calls: { councilAdapter: () => [ZeroAddress] },
    });
    const config = { title: 't', census: members(A), ballot, timing, questions };
    const disabled = await errorOf(
      orchestrator.createProcess({ ...config, keyMode: 'council', ceremonyId: cid })
    );
    expect(disabled).toBeInstanceOf(CouncilDisabledError);
    const cases: [Parameters<typeof orchestrator.createProcess>[0], string][] = [
      [{ ...config, keyMode: 'council' }, "keyMode 'council' needs a ceremonyId"],
      [
        { ...config, keyMode: 'council', ceremonyId: `0x${'00'.repeat(12)}` },
        'the ceremony id is zero',
      ],
      [{ ...config, keyMode: 'council', ceremonyId: '0xc1' }, 'ceremony id must be 12 bytes'],
      [{ ...config, keyMode: 'dkg', ceremonyId: cid }, "ceremonyId is only for keyMode 'council'"],
      [{ ...config, ceremonyId: cid }, "ceremonyId is only for keyMode 'council'"],
    ];
    for (const [c, message] of cases) {
      const err = await errorOf(orchestrator.createProcess(c));
      expect(err, message).toBeInstanceOf(ProcessCreateError);
      expect(err?.message).toContain(message);
    }
    expect(host.uploads).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it('retries a DKG creation once when the key pool is exhausted', async () => {
    let exhausted = 1;
    const { orchestrator, chain } = setup({
      calls: {
        newProcess: () =>
          exhausted-- > 0 ? revertWith(DKG_APP_MANAGER_ABI, 'PoolExhausted') : [pidOf(0)],
      },
    });
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };
    const result = await orchestrator.createProcess({ ...config, keyMode: 'dkg' });
    expect(result.processId).toBe(PID);
    expect(chain.sent).toHaveLength(1);
  });

  it('serializes the creations of one account, so each gets its own id and key', async () => {
    const { orchestrator, timeline, keyRequests, registry, api, wallet, host } = setup();
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };
    // A second service for the same account shares the lock.
    const other = new ProcessOrchestrationService(registry, api, wallet, {
      uploader: host.uploader,
      documents: { fetchImpl: host.fetchImpl },
    });
    const results = await Promise.all([
      orchestrator.createProcess(config),
      other.createProcess(config),
      orchestrator.createProcess(config),
    ]);
    expect(results.map(r => r.processId).sort()).toEqual([pidOf(0), pidOf(1), pidOf(2)]);
    expect(keyRequests).toEqual([pidOf(0), pidOf(1), pidOf(2)]);
    // Each key is asked only once the previous creation has landed.
    expect(timeline).toEqual([
      `key:${pidOf(0)}`,
      'mined:newProcess',
      `key:${pidOf(1)}`,
      'mined:newProcess',
      `key:${pidOf(2)}`,
      'mined:newProcess',
    ]);
  });

  it('releases the lock when a consumer stops reading or a creation fails', async () => {
    const { orchestrator, state, keyRequests } = setup();
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };
    for await (const event of orchestrator.createProcessStream(config)) {
      expect(event.status).toBe(TxStatus.Pending);
      break;
    }
    state.keyNodeDown = true;
    const failed = await collect(orchestrator.createProcessStream(config));
    expect(failed.map(e => e.status)).toEqual([TxStatus.Failed]);
    expect((failed[0] as { error: Error }).error.message).toContain('fetch failed');
    state.keyNodeDown = false;
    const next = await orchestrator.createProcess(config);
    expect(next.processId).toBe(pidOf(1));
    expect(keyRequests).toEqual([pidOf(0), pidOf(1)]);
  });

  it('sets the grace window as its own step right after the creation', async () => {
    const { orchestrator, sent } = setup();
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5, grace: 150 };
    const events = await collect(orchestrator.createProcessStream(config));
    expect(events.map(e => [e.status, (e as { step?: string }).step])).toEqual([
      [TxStatus.Pending, undefined],
      [TxStatus.Pending, 'setProcessGrace'],
      [TxStatus.Completed, undefined],
    ]);
    const graceHash = (events[1] as { hash: string }).hash;
    expect((events[2] as { response: unknown }).response).toEqual({
      processId: PID,
      transactionHash: (events[0] as { hash: string }).hash,
      grace: { seconds: 150, transactionHash: graceHash },
    });
    expect(sent().map(t => [t.name, t.args[0] as unknown, t.args[1] as unknown])).toEqual([
      ['newProcess', 0n, BigInt(NOW + 60)],
      ['setProcessGrace', PID, 150n],
    ]);
    // A locked creation keeps its secret next to the grace.
    const locked = await orchestrator.createProcess({
      ...config,
      grace: 600,
      keyMode: 'dkg-locked',
    });
    expect(typeof locked.organizerSecret).toBe('bigint');
    expect(locked.grace?.seconds).toBe(600);
  });

  it('refuses a grace outside the registry bounds before creating anything', async () => {
    const { orchestrator, host, chain, keyRequests } = setup();
    for (const grace of [149, 601, 150.5]) {
      await refusal(
        orchestrator.createProcess({
          title: 't',
          census: members(A),
          ballot,
          timing,
          questions,
          grace,
        }),
        ProcessGraceError,
        'InvalidGrace',
        `grace ${grace} is outside the registry's 150..600 seconds`
      );
    }
    expect(host.uploads).toHaveLength(0);
    expect(keyRequests).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it('completes a creation whose grace transaction fails, naming the failure', async () => {
    const { orchestrator, chain } = setup({
      calls: { setProcessGrace: () => revertWith(PROCESS_REGISTRY_ABI, 'InvalidTimeBounds') },
    });
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5, grace: 150 };
    const result = await orchestrator.createProcess({ ...config, keyMode: 'dkg-locked' });
    expect(result.processId).toBe(PID);
    expect(typeof result.organizerSecret).toBe('bigint');
    expect(result.grace).toBeUndefined();
    expect(result.graceError).toBeInstanceOf(ProcessGraceError);
    expect((result.graceError as ContractServiceError).revertName).toBe('InvalidTimeBounds');
    expect(orchestrator.createdProcesses).toEqual([PID]);
    expect(chain.sent).toHaveLength(1);
  });

  it('creates a process paused, which reads as paused until it resumes', async () => {
    const { orchestrator, sent, state, wallet } = setup();
    const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
    const config = { title: 't', census: csp, ballot, questions, maxVoters: 5 };
    await orchestrator.createProcess({ ...config, timing, paused: true });
    await orchestrator.createProcess({ ...config, timing, paused: false });
    expect(sent().map(t => t.args.getValue('status') as unknown)).toEqual([3n, 0n]);
    // Before the start and while voting runs; past the end the window takes over.
    for (const startTime of [NOW + 60, NOW - 100]) {
      state.process = onchainProcess(wallet.address, {
        status: ProcessStatus.PAUSED,
        startTime: BigInt(startTime),
      });
      expect((await orchestrator.getProcess(PID)).phase).toBe('paused');
    }
    await orchestrator.resumeProcess(PID);
    expect(sent().map(t => t.name)).toEqual(['newProcess', 'newProcess', 'setProcessStatus']);
  });

  it('reports a refused config as a Failed event of the stream', async () => {
    const { orchestrator } = setup();
    const events = await collect(
      orchestrator.createProcessStream({
        title: 't',
        census: members(A),
        ballot,
        questions,
        timing: { duration: 0 },
      })
    );
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe(TxStatus.Failed);
    expect((events[0] as { error: Error }).error).toBeInstanceOf(ProcessCreateError);
  });
});

describe('ProcessOrchestrationService.getProcess', () => {
  const url = 'https://files.example.org/m.json';
  const doc = buildElectionMetadata({
    title: { default: 'Parks', es: 'Parques' },
    description: 'Pick one',
    questions,
    electionPreset: { type: 'multiple_choice', maxSelections: 1 },
  });
  const bytes = serializeMetadata(doc);

  it('reads the metadata only when it hashes to the registry value', async () => {
    const { host, orchestrator, state, wallet } = setup();
    host.serve(url, { body: bytes });
    state.process = onchainProcess(wallet.address, {
      metadataURI: url,
      metadataHash: sha256(bytes),
    });
    const info = await orchestrator.getProcess(PID);
    expect(info).toMatchObject({
      title: 'Parks',
      description: 'Pick one',
      questions: [
        {
          title: 'Which site?',
          description: '',
          choices: [
            { title: 'North', value: 0 },
            { title: 'South', value: 1 },
          ],
        },
      ],
      metadataURI: url,
      metadataHash: sha256(bytes),
      metadataVerified: true,
      metadataStatus: 'verified',
      metadata: doc,
      electionPreset: { type: 'multiple_choice', maxSelections: 1, minSelections: 0 },
      census: { type: CensusOrigin.OffchainDynamic },
    });
    expect(info.metadataError).toBeUndefined();

    state.process = onchainProcess(wallet.address, {
      metadataURI: url,
      metadataHash: `0x${'aa'.repeat(32)}`,
    });
    const mismatch = await orchestrator.getProcess(PID);
    expect(mismatch).toMatchObject({
      title: '',
      questions: [],
      metadataVerified: false,
      metadataStatus: 'mismatch',
    });
    expect(mismatch.metadata).toBeUndefined();
    expect(mismatch.electionPreset).toBeUndefined();
    expect(mismatch.metadataError).toContain('the registry has 0xaaaa');

    state.process = onchainProcess(wallet.address, {
      metadataURI: 'https://files.example.org/gone.json',
    });
    expect(await orchestrator.getProcess(PID)).toMatchObject({
      metadataVerified: false,
      metadataStatus: 'unreachable',
    });
  });

  it('drops choices whose value is not a number from a verified document', async () => {
    const { host, orchestrator, state, wallet } = setup();
    const raw = toUtf8Bytes(
      '{"title":"t","questions":[{"title":"q","choices":[{"title":"a","value":"0"},{"title":"b","value":1}]}]}'
    );
    host.serve(url, { body: raw });
    state.process = onchainProcess(wallet.address, { metadataURI: url, metadataHash: sha256(raw) });
    const info = await orchestrator.getProcess(PID);
    expect(info.metadataStatus).toBe('verified');
    expect(info.questions).toEqual([
      { title: 'q', description: undefined, choices: [{ title: 'b', value: 1 }] },
    ]);
  });

  it('never requests a metadata URI outside the URL policy', async () => {
    const { host, orchestrator, state, wallet } = setup();
    for (const uri of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5:9200/_cluster/health',
      'http://[::1]/m.json',
      'data:application/json,{}',
    ]) {
      host.serve(uri, { body: bytes });
      state.process = onchainProcess(wallet.address, {
        metadataURI: uri,
        metadataHash: sha256(bytes),
      });
      const info = await orchestrator.getProcess(PID);
      expect(info, uri).toMatchObject({
        title: '',
        questions: [],
        metadataVerified: false,
        metadataStatus: 'refused',
      });
      expect(info.metadata).toBeUndefined();
    }
    expect(host.fetches).toHaveLength(0);
  });

  it('gives an on-chain census its contract', async () => {
    const { orchestrator, state, wallet } = setup();
    state.process = onchainProcess(wallet.address, {
      census: {
        censusOrigin: 3,
        censusRoot: `0x${'00'.repeat(31)}09`,
        contractAddress: CONTRACT,
        censusURI: 'onchain://x',
        onchainAllowAnyValidRoot: false,
      },
    });
    expect((await orchestrator.getProcess(PID)).census).toEqual({
      type: CensusOrigin.Onchain,
      root: `0x${'00'.repeat(31)}09`,
      uri: 'onchain://x',
      contractAddress: getAddress(CONTRACT),
    });
  });

  it('places the process on its timeline by the chain clock and the grace window', async () => {
    const { orchestrator, state, wallet, chain } = setup();
    const at = (seconds: number) => new Date(seconds * 1000);
    const read = async (overrides: Process) => {
      state.process = onchainProcess(wallet.address, overrides);
      return orchestrator.getProcess(PID);
    };
    const upcoming = await read({ startTime: BigInt(NOW + 100) });
    expect(upcoming).toMatchObject({
      phase: 'upcoming',
      timeRemaining: -100,
      startDate: at(NOW + 100),
      endDate: at(NOW + 3700),
      graceEnd: at(NOW + 3700 + 180),
      grace: 180,
      lastVoteAt: null,
      chainTime: at(NOW),
      keyMode: KeyMode.Sequencer,
      stateRoot: `0x${'04'.repeat(32)}`,
    });
    expect(upcoming.dkg).toBeUndefined();
    expect(await read({})).toMatchObject({ phase: 'open', timeRemaining: 3500 });
    expect(await read({ status: ProcessStatus.PAUSED })).toMatchObject({ phase: 'paused' });

    // Ended 400 s ago with a 180 s window, then with batches landing after the end.
    const past = { startTime: BigInt(NOW - 4000) };
    expect(await read(past)).toMatchObject({
      phase: 'ended',
      timeRemaining: 0,
      graceEnd: at(NOW - 220),
    });
    expect(await read({ ...past, lastVoteAt: BigInt(NOW - 100) })).toMatchObject({
      phase: 'closing',
      lastVoteAt: at(NOW - 100),
      graceEnd: at(NOW + 80),
    });
    // The window never closes later than the end plus graceMaxTotal.
    expect(await read({ ...past, grace: 600, lastVoteAt: BigInt(NOW + 1300) })).toMatchObject({
      phase: 'closing',
      graceEnd: at(NOW - 400 + 1800),
    });
    chain.headTime = NOW + 1400;
    expect(
      await read({ ...past, status: ProcessStatus.PAUSED, lastVoteAt: BigInt(NOW + 1300) })
    ).toMatchObject({
      phase: 'ended',
    });
    chain.headTime = NOW;
    expect(await read({ ...past, status: ProcessStatus.RESULTS, result: [3n, 4n] })).toMatchObject({
      phase: 'results',
      result: [3n, 4n],
    });
    expect(await read({ status: ProcessStatus.CANCELED })).toMatchObject({ phase: 'canceled' });

    const locked = await read({
      keyMode: 2,
      dkgEpochId: EPOCH,
      dkgAid: AID,
      encryptionKey: { x: KEY_POINT.x, y: KEY_POINT.y },
    });
    expect(locked.keyMode).toBe(KeyMode.DkgLocked);
    expect(locked.dkg).toMatchObject({
      locked: true,
      epochId: EPOCH,
      aid: AID,
      resultsRequested: false,
    });
  });

  it('reads the grace parameters once, and the grace end from the registry', async () => {
    const { orchestrator, chain } = setup();
    const params = {
      defaultGrace: 180,
      graceFloor: 150,
      graceCeil: 600,
      graceMaxTotal: 1800,
      noticeMin: 60,
    };
    expect(await orchestrator.getGraceParams()).toEqual(params);
    await orchestrator.getProcess(PID);
    await orchestrator.getProcess(PID);
    const calls = chain
      .calls('eth_call')
      .map(r => iface.parseTransaction({ data: (r.params as [{ data: string }])[0].data })?.name);
    expect(calls.filter(n => n === 'graceMaxTotal')).toHaveLength(1);
    expect(await orchestrator.getGraceEnd(PID)).toEqual(new Date((NOW + 3680) * 1000));
  });

  it('gives no date for a window that never closes, or a process that does not exist', async () => {
    const { orchestrator, state, wallet } = setup();
    const max = (1n << 256n) - 1n;
    state.graceEnd = max;
    expect(await orchestrator.getGraceEnd(PID)).toBeNull();
    // The registry answers 0 for an id it does not hold.
    state.graceEnd = 0n;
    expect(await orchestrator.getGraceEnd(PID)).toBeNull();
    // The latest date a Date holds is still one.
    state.graceEnd = 8_640_000_000_000n;
    expect(await orchestrator.getGraceEnd(PID)).toEqual(new Date(8_640_000_000_000_000));
    // An end within graceMaxTotal of 2^256: the window never closes.
    state.process = onchainProcess(wallet.address, { duration: max - BigInt(NOW - 100) - 10n });
    const info = await orchestrator.getProcess(PID);
    expect(info.graceEnd).toBeNull();
    expect(info.phase).toBe('open');
  });
});

describe('ProcessOrchestrationService organizer controls', () => {
  const statusOf = (t: { args: Result }) => [t.args[0] as unknown, t.args[1] as unknown];

  it('ends, pauses, resumes and cancels within the registry rules', async () => {
    const { orchestrator, state, wallet, sent } = setup();
    const set = (overrides: Process) => (state.process = onchainProcess(wallet.address, overrides));
    await orchestrator.endProcess(PID);
    await orchestrator.pauseProcess(PID);
    set({ status: ProcessStatus.PAUSED });
    await orchestrator.resumeProcess(PID);
    await orchestrator.cancelProcess(PID);
    // Past the end: END keeps the end, a paused process resumes, cancel still works.
    set({ startTime: BigInt(NOW - 4000) });
    await orchestrator.endProcess(PID);
    await orchestrator.cancelProcess(PID);
    set({ startTime: BigInt(NOW - 4000), status: ProcessStatus.PAUSED });
    await orchestrator.resumeProcess(PID);
    expect(sent().map(statusOf)).toEqual([
      [PID, 1n],
      [PID, 3n],
      [PID, 0n],
      [PID, 2n],
      [PID, 1n],
      [PID, 2n],
      [PID, 0n],
    ]);
  });

  it('refuses status changes the registry refuses, with the registry error, sending nothing', async () => {
    const { orchestrator, state, wallet, chain } = setup();
    const set = (overrides: Process) => (state.process = onchainProcess(wallet.address, overrides));
    set({ startTime: BigInt(NOW + 100) });
    await refusal(
      orchestrator.endProcess(PID),
      ProcessStatusError,
      'InvalidTimeBounds',
      'starts at 2023-11-14T22:15:00.000Z and cannot end before it starts; cancel it instead'
    );
    set({ startTime: BigInt(NOW - 4000) });
    await refusal(
      orchestrator.pauseProcess(PID),
      ProcessStatusError,
      'InvalidTimeBounds',
      'ended at 2023-11-14T22:06:40.000Z; a pause works only before the end'
    );
    set({ status: ProcessStatus.PAUSED });
    await refusal(
      orchestrator.pauseProcess(PID),
      ProcessStatusError,
      'InvalidStatus',
      'cannot pause process'
    );
    set({});
    await refusal(
      orchestrator.resumeProcess(PID),
      ProcessStatusError,
      'InvalidStatus',
      'it is READY, and only a PAUSED process can'
    );
    for (const status of [ProcessStatus.ENDED, ProcessStatus.CANCELED, ProcessStatus.RESULTS]) {
      set({ status });
      await refusal(
        orchestrator.endProcess(PID),
        ProcessStatusError,
        'InvalidStatus',
        'only a READY or PAUSED process can'
      );
      await refusal(
        orchestrator.cancelProcess(PID),
        ProcessStatusError,
        'InvalidStatus',
        `it is ${ProcessStatus[status]}`
      );
    }
    state.process = onchainProcess(getAddress(B));
    await refusal(
      orchestrator.cancelProcess(PID),
      ProcessStatusError,
      'Unauthorized',
      `only the organizer ${getAddress(B)} can cancel process ${PID}`
    );
    expect(chain.sent).toHaveLength(0);
  });

  it('extends and shortens with notice on the chain clock', async () => {
    const { orchestrator, state, wallet, sent } = setup();
    expect(await orchestrator.extendProcess(PID, 600)).toEqual({ success: true, duration: 4200n });
    // Closes max(seconds, noticeMin) + slack from the head, counted from the start.
    expect(await orchestrator.closeProcessIn(PID, 30, { slack: 6 })).toEqual({
      success: true,
      duration: BigInt(60 + 6 + 100),
    });
    expect(await orchestrator.closeProcessIn(PID, 120)).toEqual({
      success: true,
      duration: BigInt(120 + 45 + 100),
    });
    expect(sent().map(t => [t.name, t.args[1] as unknown])).toEqual([
      ['setProcessDuration', 4200n],
      ['setProcessDuration', 166n],
      ['setProcessDuration', 265n],
    ]);
    // Not an earlier end: nothing to shorten.
    state.process = onchainProcess(wallet.address, { duration: 200n });
    await refusal(
      orchestrator.closeProcessIn(PID, 60),
      ProcessDurationError,
      undefined,
      'already ends by then'
    );
  });

  it('refuses to close a process before it starts', async () => {
    const { orchestrator, state, wallet, chain } = setup();
    state.process = onchainProcess(wallet.address, { startTime: BigInt(NOW + 86_400) });
    await refusal(
      orchestrator.closeProcessIn(PID, 60),
      ProcessDurationError,
      undefined,
      'starts at 2023-11-15T22:13:20.000Z and cannot close before it starts; cancel it'
    );
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses duration changes the registry refuses', async () => {
    const { orchestrator, state, wallet, chain } = setup();
    for (const seconds of [0, -1, 1.5]) {
      await refusal(
        orchestrator.extendProcess(PID, seconds),
        ProcessDurationError,
        'InvalidDuration',
        'not a positive integer'
      );
    }
    await refusal(
      orchestrator.closeProcessIn(PID, -1),
      ProcessDurationError,
      undefined,
      'not a non-negative integer'
    );
    await refusal(
      orchestrator.closeProcessIn(PID, 60, { slack: 0.5 }),
      ProcessDurationError,
      undefined,
      'slack 0.5'
    );
    state.process = onchainProcess(wallet.address, { startTime: BigInt(NOW - 4000) });
    await refusal(
      orchestrator.extendProcess(PID, 60),
      ProcessDurationError,
      'InvalidTimeBounds',
      'cannot extend process'
    );
    await refusal(
      orchestrator.closeProcessIn(PID, 60),
      ProcessDurationError,
      'InvalidTimeBounds',
      'and the registry allows it only before the end'
    );
    state.process = onchainProcess(wallet.address, { status: ProcessStatus.ENDED });
    await refusal(
      orchestrator.closeProcessIn(PID, 60),
      ProcessDurationError,
      'InvalidStatus',
      'it is ENDED'
    );
    expect(chain.sent).toHaveLength(0);
  });

  it('sets the grace window within the registry bounds, before the end', async () => {
    const { orchestrator, state, wallet, sent, chain } = setup();
    await orchestrator.setProcessGrace(PID, 150);
    await orchestrator.setProcessGrace(PID, 600);
    expect(sent().map(t => [t.name, t.args[1] as unknown])).toEqual([
      ['setProcessGrace', 150n],
      ['setProcessGrace', 600n],
    ]);
    for (const grace of [149, 601, 180.5]) {
      await refusal(
        orchestrator.setProcessGrace(PID, grace),
        ProcessGraceError,
        'InvalidGrace',
        `grace ${grace} is outside the registry's 150..600 seconds`
      );
    }
    state.process = onchainProcess(wallet.address, { startTime: BigInt(NOW - 4000) });
    await refusal(
      orchestrator.setProcessGrace(PID, 150),
      ProcessGraceError,
      'InvalidTimeBounds',
      'cannot set the grace window of process'
    );
    expect(chain.sent).toHaveLength(2);
  });

  it('sets max voters above the voters counted and within the result cap, before the end', async () => {
    const { orchestrator, state, wallet, sent } = setup();
    const set = (overrides: Process) => (state.process = onchainProcess(wallet.address, overrides));
    set({ votersCount: 10n });
    await orchestrator.setProcessMaxVoters(PID, 10);
    await refusal(
      orchestrator.setProcessMaxVoters(PID, 9),
      ProcessMaxVotersError,
      'InvalidMaxVoters',
      'maxVoters 9 is below the 10 voters already counted'
    );
    await refusal(
      orchestrator.setProcessMaxVoters(PID, 0),
      ProcessMaxVotersError,
      'InvalidMaxVoters',
      'maxVoters 0 is not a positive integer'
    );
    set({
      ballotMode: { ...(onchainProcess(ORGANIZER).ballotMode as object), maxValue: 1_000_000n },
    });
    await orchestrator.setProcessMaxVoters(PID, 1_000_000);
    await refusal(
      orchestrator.setProcessMaxVoters(PID, 1_000_001),
      ProcessMaxVotersError,
      'MaxPossibleResultCapExceeded',
      "exceeds the registry's result cap"
    );
    set({ startTime: BigInt(NOW - 4000) });
    await refusal(
      orchestrator.setProcessMaxVoters(PID, 50),
      ProcessMaxVotersError,
      'InvalidTimeBounds',
      'only before the end'
    );
    expect(sent().map(t => t.args[1] as unknown)).toEqual([10n, 1_000_000n]);
  });

  it('reveals the key of a DKG-locked process, for anyone holding the secret', async () => {
    const { orchestrator, state, sent } = setup();
    state.process = onchainProcess(getAddress(B), { keyMode: 2, dkgEpochId: EPOCH, dkgAid: AID });
    await orchestrator.revealProcessKey(PID, 42n);
    expect(sent().map(t => [t.name, t.args[0] as unknown, t.args[1] as unknown])).toEqual([
      ['revealProcessKey', PID, 42n],
    ]);
    for (const secret of [0n, BJJ_SUBGROUP_ORDER]) {
      await refusal(
        orchestrator.revealProcessKey(PID, secret),
        ProcessKeyRevealError,
        'InvalidOrganizerSecret',
        'not a scalar in [1, L)'
      );
    }
    state.process = onchainProcess(getAddress(B), { keyMode: 1, dkgEpochId: EPOCH, dkgAid: AID });
    await refusal(
      orchestrator.revealProcessKey(PID, 42n),
      ProcessKeyRevealError,
      'InvalidKeyMode',
      'is DkgAutomatic; only a DkgLocked process has an organizer key'
    );
    state.process = onchainProcess(getAddress(B));
    await refusal(
      orchestrator.revealProcessKey(PID, 42n),
      ProcessKeyRevealError,
      'InvalidKeyMode',
      'is Sequencer'
    );
    expect(sent()).toHaveLength(1);
  });

  it('leaves the last word to the registry’s simulation', async () => {
    const { orchestrator, chain, state, wallet } = setup({
      calls: {
        setProcessGrace: () => revertWith(PROCESS_REGISTRY_ABI, 'InvalidGrace'),
        revealProcessKey: () => revertWith(DKG_APP_MANAGER_ABI, 'InvalidOrganizerSecret'),
      },
    });
    await refusal(
      orchestrator.setProcessGrace(PID, 200),
      ProcessGraceError,
      'InvalidGrace',
      'setProcessGrace reverted: InvalidGrace'
    );
    state.process = onchainProcess(wallet.address, { keyMode: 2, dkgEpochId: EPOCH, dkgAid: AID });
    await refusal(
      orchestrator.revealProcessKey(PID, 42n),
      ProcessKeyRevealError,
      'InvalidOrganizerSecret',
      'revealProcessKey reverted: InvalidOrganizerSecret'
    );
    expect(chain.sent).toHaveLength(0);
  });

  it('reports a refusal as a Failed event of the stream', async () => {
    const { orchestrator, state, wallet } = setup();
    state.process = onchainProcess(wallet.address, { startTime: BigInt(NOW - 4000) });
    const streams = [
      orchestrator.pauseProcessStream(PID),
      orchestrator.extendProcessStream(PID, 60),
      orchestrator.closeProcessInStream(PID, 60),
      orchestrator.setProcessGraceStream(PID, 150),
      orchestrator.setProcessMaxVotersStream(PID, 5),
      orchestrator.updateMetadataStream(PID, { uri: 'https://files.example.org/m.json' }),
    ];
    for (const stream of streams) {
      const events = await collect<unknown>(stream);
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe(TxStatus.Failed);
      expect(((events[0] as { error: unknown }).error as ContractServiceError).revertName).toBe(
        'InvalidTimeBounds'
      );
    }
  });
});

describe('ProcessOrchestrationService time windows', () => {
  it('uses the registry boundaries: the start opens END, the end closes the rest', async () => {
    const { orchestrator, state, wallet, sent } = setup();
    const set = (overrides: Process) => (state.process = onchainProcess(wallet.address, overrides));
    // The chain head at the start: END goes through (block.timestamp >= startTime).
    set({ startTime: BigInt(NOW) });
    await orchestrator.endProcess(PID);
    set({ startTime: BigInt(NOW + 1) });
    await refusal(
      orchestrator.endProcess(PID),
      ProcessStatusError,
      'InvalidTimeBounds',
      'cannot end'
    );
    // One second before the end every change goes through; at the end none does.
    set({ startTime: BigInt(NOW - 3599) });
    await orchestrator.pauseProcess(PID);
    await orchestrator.setProcessGrace(PID, 150);
    await orchestrator.setProcessMaxVoters(PID, 5);
    await orchestrator.extendProcess(PID, 1);
    set({ startTime: BigInt(NOW - 3600) });
    await refusal(orchestrator.pauseProcess(PID), ProcessStatusError, 'InvalidTimeBounds', 'pause');
    await refusal(
      orchestrator.setProcessGrace(PID, 150),
      ProcessGraceError,
      'InvalidTimeBounds',
      'grace'
    );
    await refusal(
      orchestrator.setProcessMaxVoters(PID, 5),
      ProcessMaxVotersError,
      'InvalidTimeBounds',
      'max voters'
    );
    await refusal(
      orchestrator.extendProcess(PID, 1),
      ProcessDurationError,
      'InvalidTimeBounds',
      'extend'
    );
    await refusal(
      orchestrator.updateMetadata(PID, {
        uri: 'https://files.example.org/m.json',
        hash: `0x${'ab'.repeat(32)}`,
      }),
      ProcessMetadataError,
      'InvalidTimeBounds',
      'metadata'
    );
    expect(sent().map(t => t.name)).toEqual([
      'setProcessStatus',
      'setProcessStatus',
      'setProcessGrace',
      'setProcessMaxVoters',
      'setProcessDuration',
    ]);
  });
});

describe('ProcessOrchestrationService.updateCensus', () => {
  it('publishes the new version and moves the process to it', async () => {
    const { host, orchestrator, sent } = setup();
    const dynamic = new OffchainDynamicCensus();
    dynamic.add([A, B]);
    await orchestrator.updateCensus(PID, dynamic);
    expect(host.uploads.map(u => u.kind)).toEqual(['census']);
    const [update] = sent();
    expect(update.name).toBe('setProcessCensus');
    expect(update.args[0]).toBe(PID.toLowerCase());
    expect([...(update.args[1] as Result)]).toEqual([
      2n,
      await dynamic.root(),
      ZeroAddress,
      host.urlOf(dynamic.serialize()),
      false,
    ]);
    // A census file served elsewhere, by root and URL.
    const url = 'https://census.example.org/v3.json';
    host.serve(url, { body: dynamic.serialize() });
    await orchestrator.updateCensus(PID, { root: await dynamic.root(), uri: url });
    expect([...(sent()[1].args[1] as Result)][3]).toBe(url);
  });

  it('refuses before any upload a census that cannot change, or is not the organizer’s', async () => {
    const { host, orchestrator, state, chain, wallet } = setup();
    const dynamic = new OffchainDynamicCensus();
    dynamic.add(A);
    state.process = onchainProcess(wallet.address, {
      census: { ...(onchainProcess(wallet.address).census as object), censusOrigin: 1 },
    });
    await refusal(
      orchestrator.updateCensus(PID, dynamic),
      CensusNotUpdatable,
      'CensusNotUpdatable',
      'only an updatable Merkle census (origin 2) can be replaced'
    );
    state.process = onchainProcess(wallet.address, { status: ProcessStatus.ENDED });
    await refusal(
      orchestrator.updateCensus(PID, dynamic),
      ProcessCensusError,
      'InvalidStatus',
      'it is ENDED, and only a READY or PAUSED process changes'
    );
    state.process = onchainProcess(wallet.address, { startTime: BigInt(NOW - 4000) });
    await refusal(
      orchestrator.updateCensus(PID, dynamic),
      ProcessCensusError,
      'InvalidTimeBounds',
      'only before the end'
    );
    state.process = onchainProcess(getAddress(B));
    await refusal(
      orchestrator.updateCensus(PID, dynamic),
      ProcessCensusError,
      'Unauthorized',
      'only the organizer'
    );
    state.process = onchainProcess(wallet.address);
    await expect(orchestrator.updateCensus(PID, members(A))).rejects.toThrow(CensusError);
    expect(host.uploads).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });
});

describe('ProcessOrchestrationService.updateMetadata', () => {
  it('publishes a config, a document or bytes, or takes a URL, then sets it', async () => {
    const { host, orchestrator, sent } = setup();
    const config = { title: 'Parks', questions };
    const doc = buildElectionMetadata({ ...config, description: 'v2' });
    const raw = toUtf8Bytes('{"title":{"default":"raw"}}');
    const url = 'https://files.example.org/m3.json';
    host.serve(url, { body: raw });
    await orchestrator.updateMetadata(PID, config);
    await orchestrator.updateMetadata(PID, doc);
    await orchestrator.updateMetadata(PID, raw);
    await orchestrator.updateMetadata(PID, { uri: url });
    await orchestrator.updateMetadata(PID, { uri: url, hash: `0x${'ab'.repeat(32)}` });
    const built = serializeMetadata(buildElectionMetadata(config));
    expect(host.uploads.map(u => u.data)).toEqual([built, serializeMetadata(doc), raw]);
    expect(sent().map(t => [t.name, t.args[1] as unknown, t.args[2] as unknown])).toEqual([
      ['setProcessMetadata', host.urlOf(built), sha256(built)],
      ['setProcessMetadata', host.urlOf(serializeMetadata(doc)), sha256(serializeMetadata(doc))],
      ['setProcessMetadata', host.urlOf(raw), sha256(raw)],
      ['setProcessMetadata', url, sha256(raw)],
      ['setProcessMetadata', url, `0x${'ab'.repeat(32)}`],
    ]);
  });

  it('refuses a closed process before uploading', async () => {
    const { host, orchestrator, state, wallet } = setup();
    state.process = onchainProcess(wallet.address, { status: ProcessStatus.CANCELED });
    await refusal(
      orchestrator.updateMetadata(PID, { title: 't', questions }),
      ProcessMetadataError,
      'InvalidStatus',
      'READY or PAUSED'
    );
    state.process = onchainProcess(wallet.address, { startTime: BigInt(NOW - 4000) });
    await refusal(
      orchestrator.updateMetadata(PID, { title: 't', questions }),
      ProcessMetadataError,
      'InvalidTimeBounds',
      'only before the end'
    );
    state.process = onchainProcess(wallet.address);
    await refusal(
      orchestrator.updateMetadata(PID, { uri: '' }),
      ProcessMetadataError,
      'InvalidMetadata',
      'the metadata URI is empty'
    );
    expect(host.uploads).toHaveLength(0);
  });
});

describe('ProcessOrchestrationService.cancelOpenProcesses', () => {
  const csp = new PublishedCensus(CensusOrigin.CSP, A, 'https://csp.example.org');
  const config = { title: 't', census: csp, ballot, timing, questions, maxVoters: 5 };

  it('cancels the open processes this service created, and reports the rest', async () => {
    const { orchestrator, state, wallet, sent } = setup();
    for (let i = 0; i < 3; i++) await orchestrator.createProcess(config);
    state.byId.set(pidOf(1), onchainProcess(wallet.address, { status: ProcessStatus.ENDED }));
    state.byId.set(pidOf(2), onchainProcess(wallet.address, { status: ProcessStatus.PAUSED }));
    const result = await orchestrator.cancelOpenProcesses();
    expect(result).toEqual({ canceled: [pidOf(0), pidOf(2)], failed: [] });
    expect(
      sent()
        .filter(t => t.name === 'setProcessStatus')
        .map(t => [t.args[0] as unknown, t.args[1] as unknown])
    ).toEqual([
      [pidOf(0), 2n],
      [pidOf(2), 2n],
    ]);

    // Given ids: another organizer's process fails, the others go on.
    const foreign = pidOf(0, B);
    state.byId.set(foreign, onchainProcess(getAddress(B)));
    const mixed = await orchestrator.cancelOpenProcesses({ processIds: [foreign, pidOf(0)] });
    expect(mixed.canceled).toEqual([pidOf(0)]);
    expect(mixed.failed.map(f => f.processId)).toEqual([foreign]);
    expect((mixed.failed[0].error as ContractServiceError).revertName).toBe('Unauthorized');
  });

  it('finds every process of the signer by its nonce with all', async () => {
    const { orchestrator, state, wallet, sent } = setup();
    state.nonce = 3;
    state.byId.set(pidOf(1), onchainProcess(wallet.address, { status: ProcessStatus.RESULTS }));
    const result = await orchestrator.cancelOpenProcesses({ all: true });
    expect(result).toEqual({ canceled: [pidOf(0), pidOf(2)], failed: [] });
    expect(sent()).toHaveLength(2);
    await expect(
      orchestrator.cancelOpenProcesses({ all: true, processIds: [PID] })
    ).rejects.toThrow('give processIds or all, not both');
  });
});
