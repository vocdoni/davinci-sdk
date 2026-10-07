import { Interface, Wallet, ZeroAddress, sha256 } from 'ethers';
import {
  COUNCIL_ADAPTER_ABI,
  COUNCIL_POLICY_ABI,
  CouncilDisabledError,
  DAVINCI_DKG_ADAPTER_ABI,
  DKG_APP_MANAGER_ABI,
  DkgDisabledError,
  KeyMode,
  PROCESS_REGISTRY_ABI,
  ProcessRegistryService,
  ProcessResultError,
  ProcessStatus,
} from '../../../src/contracts';
import { VocdoniApiService } from '../../../src/core/api/ApiService';
import {
  RESULTS_MARGIN_MS,
  ResultsError,
  VoteOrchestrationService,
  ballotKindOf,
  buildElectionMetadata,
  decodeResults,
  resolveElectionPreset,
  ballotModeValues,
  type BallotMode,
  type ElectionPreset,
  type ResultsSource,
  type ResultsState,
  type ResultsStatus,
  serializeMetadata,
} from '../../../src/core';
import { bjjMulBase } from '../../../src/crypto';
import { GNOSIS, computeProcessId } from '../../../src/networks';
import { DocumentHost } from '../../helpers/documentHost';
import { MockChain, revertWith } from '../../helpers/mockChain';

const REGISTRY = GNOSIS.processRegistry;
const ADAPTER = '0xE9559c78E7ff8c19937A0657a092A221E90CCBC3';
const COUNCIL_ADAPTER = '0x000000000000000000000000000000000000C1a7';
const COUNCIL_MANAGER = '0x000000000000000000000000000000000000c0DE';
const APP_MANAGER = '0x9999F38Ff8Bf959E98Ddd5D4551f82775219c01B';
const ORGANIZER = `0x${'0a'.repeat(20)}`;
const PID = computeProcessId(ORGANIZER, '0x83f2e36e', 3);
const NOW = 1_700_000_000;
const EPOCH = `0x${'0e'.repeat(12)}`;
const AID = `0x${'0d'.repeat(32)}`;
const KEY = `0x${'44'.repeat(32)}`;
const iface = new Interface(PROCESS_REGISTRY_ABI);

// A mode of `preset` for `n` choices.
const modeOf = (preset: ElectionPreset, n: number) =>
  ballotModeValues(
    resolveElectionPreset(preset, [{ choices: Array.from({ length: n }, (_, i) => i) }])
  );

const asBallot = (m: ReturnType<typeof ballotModeValues>): BallotMode => ({
  numFields: m.numFields,
  groupSize: m.groupSize,
  uniqueValues: m.uniqueValues,
  costExponent: m.costExponent,
  maxValue: String(m.maxValue),
  minValue: String(m.minValue),
  maxValueSum: String(m.maxValueSum),
  minValueSum: String(m.minValueSum),
});

const question = (title: string, choices: string[], first = 0) => ({
  title,
  choices: choices.map((c, i) => ({ title: c, value: first + i })),
});

describe('ballotKindOf', () => {
  it('reads every preset back from its mode', () => {
    const table: [ElectionPreset, number, string][] = [
      [{ type: 'single_choice' }, 4, 'single_choice'],
      [{ type: 'single_choice', allowAbstain: true }, 4, 'single_choice'],
      [{ type: 'multiple_choice', maxSelections: 2 }, 4, 'multiple_choice'],
      [{ type: 'multiple_choice', maxSelections: 4, minSelections: 1 }, 4, 'multiple_choice'],
      [{ type: 'approval' }, 5, 'approval'],
      [{ type: 'rating', maxValue: 5 }, 3, 'rating'],
      [{ type: 'rating', maxValue: 10, minValue: 1 }, 16, 'rating'],
      [{ type: 'ranking' }, 5, 'ranking'],
      [{ type: 'quadratic', budget: 100 }, 4, 'quadratic'],
      [{ type: 'quadratic', budget: 9, minValueSum: 1 }, 2, 'quadratic'],
      // Presets with the same parameters read the same way.
      [{ type: 'multiple_choice', maxSelections: 1 }, 4, 'single_choice'],
      [{ type: 'multiple_choice', maxSelections: 4 }, 4, 'approval'],
      [{ type: 'rating', maxValue: 1 }, 4, 'approval'],
    ];
    for (const [preset, n, kind] of table) {
      expect(ballotKindOf(modeOf(preset, n)), JSON.stringify(preset)).toBe(kind);
    }
  });

  it('reads any other mode as custom', () => {
    const base = modeOf({ type: 'rating', maxValue: 5 }, 3);
    const custom = [
      { ...base, maxValueSum: 0n, minValueSum: 0n }, // the weight is the budget
      { ...base, costExponent: 3 },
      { ...base, maxValueSum: 14n },
      { ...modeOf({ type: 'ranking' }, 4), uniqueValues: false },
      { ...modeOf({ type: 'ranking' }, 4), maxValue: 5n },
      // No ballot meets a floor above the ceiling.
      { ...modeOf({ type: 'multiple_choice', maxSelections: 3 }, 4), minValueSum: 7n },
      { ...modeOf({ type: 'single_choice' }, 4), minValueSum: 2n },
      { ...modeOf({ type: 'rating', maxValue: 5, minValue: 1 }, 3), minValueSum: 0n },
      { ...modeOf({ type: 'quadratic', budget: 16 }, 3), maxValue: 4n },
    ];
    for (const m of custom) expect(ballotKindOf(m)).toBe('custom');
  });
});

describe('decodeResults', () => {
  const source = (
    preset: ElectionPreset | undefined,
    questions: ResultsSource['questions'],
    result: bigint[],
    voters: number,
    mode = preset ? modeOf(preset, result.length) : modeOf({ type: 'approval' }, result.length)
  ): ResultsSource => ({
    processId: PID,
    ballot: asBallot(mode),
    result,
    votersCount: voters,
    questions,
    ...(preset && { electionPreset: preset }),
  });

  it('names the choices and gives each its share of the ballots', () => {
    const results = decodeResults(
      source(
        { type: 'single_choice' },
        [question('Which site?', ['North', 'South', 'East'])],
        [5n, 3n, 2n],
        10
      )
    );
    expect(results).toEqual({
      processId: PID,
      kind: 'single_choice',
      values: [5n, 3n, 2n],
      voters: 10,
      questions: [
        {
          title: 'Which site?',
          choices: [
            { field: 0, title: 'North', total: 5n, mean: 0.5 },
            { field: 1, title: 'South', total: 3n, mean: 0.3 },
            { field: 2, title: 'East', total: 2n, mean: 0.2 },
          ],
        },
      ],
    });
  });

  it('gives mean ratings, ranks and quadratic votes', () => {
    const rating = decodeResults(
      source({ type: 'rating', maxValue: 5 }, [question('Rate', ['a', 'b'])], [17n, 8n], 4)
    );
    expect(rating.kind).toBe('rating');
    expect(rating.questions[0].choices.map(c => c.mean)).toEqual([4.25, 2]);

    // Lower is preferred: b was ranked first by most.
    const ranking = decodeResults(
      source({ type: 'ranking' }, [question('Rank', ['a', 'b', 'c'])], [8n, 5n, 11n], 4)
    );
    expect(ranking.kind).toBe('ranking');
    expect(ranking.questions[0].choices.map(c => c.mean)).toEqual([2, 1.25, 2.75]);

    const quadratic = decodeResults(
      source({ type: 'quadratic', budget: 16 }, [question('Fund', ['a', 'b'])], [9n, 3n], 3)
    );
    expect(quadratic.kind).toBe('quadratic');
    expect(quadratic.questions[0].choices.map(c => c.mean)).toEqual([3, 1]);
  });

  it('takes the kind from the mode when the metadata preset does not produce it', () => {
    // The document claims a rating; the registry's mode is an approval of three.
    const claim = source(
      { type: 'rating', maxValue: 5 },
      [question('Q', ['a', 'b', 'c'])],
      [1n, 2n, 3n],
      3,
      modeOf({ type: 'approval' }, 3)
    );
    expect(decodeResults(claim).kind).toBe('approval');
    // A weight budget is no preset.
    const budget = source(undefined, [], [4n, 6n], 2, modeOf({ type: 'rating', maxValue: 5 }, 2));
    budget.ballot = { ...budget.ballot, maxValueSum: '0', minValueSum: '0' };
    expect(decodeResults(budget).kind).toBe('custom');
  });

  it('lists every field without metadata, and groups questions by their fields', () => {
    const bare = decodeResults(source(undefined, [], [1n, 0n, 2n], 0));
    expect(bare.questions).toEqual([
      {
        choices: [
          { field: 0, total: 1n, mean: null },
          { field: 1, total: 0n, mean: null },
          { field: 2, total: 2n, mean: null },
        ],
      },
    ]);

    // Two yes/no questions over four fields; a choice outside the fields is dropped.
    const two = decodeResults(
      source(
        undefined,
        [
          question('First', ['yes', 'no']),
          {
            title: '',
            choices: [...question('', ['yes', 'no'], 2).choices, { title: 'x', value: 9 }],
          },
        ],
        [3n, 1n, 2n, 2n],
        4
      )
    );
    expect(two.questions.map(q => q.title)).toEqual(['First', undefined]);
    expect(two.questions[1].choices.map(c => [c.field, c.total])).toEqual([
      [2, 2n],
      [3, 2n],
    ]);
  });

  it('refuses a process without results', () => {
    expect(() =>
      decodeResults(source(undefined, [], [], 3, modeOf({ type: 'approval' }, 3)))
    ).toThrow('has no results yet');
  });
});

interface Chain {
  status: ProcessStatus;
  keyMode: KeyMode;
  requested: boolean;
  count: number;
  result: bigint[];
  votersCount: bigint;
  ready: boolean;
  secret: bigint;
  /** The Council ceremony's decryption gate and policy (PhaseMode 0 Manual, 1 Scheduled). */
  gateOpen: boolean;
  decryptionMode: number;
  decryptionOpenAt: bigint;
  fallbackAt: bigint;
}

// A process that ended at NOW - 3600, grace 180: the window closed at NOW - 3420. The
// chain head is 20 s past it.
function setup(overrides: Partial<Chain> = {}) {
  const chain = new MockChain();
  chain.headTime = NOW - 3400;
  const wallet = new Wallet(KEY, chain);
  const host = new DocumentHost();
  const doc = buildElectionMetadata({
    title: 'Park',
    questions: [question('Which site?', ['North', 'South', 'East'])],
    electionPreset: { type: 'single_choice' },
  });
  const bytes = serializeMetadata(doc);
  const metadataURI = host.urlOf(bytes);
  host.serve(metadataURI, { body: bytes });
  const state: Chain = {
    status: ProcessStatus.READY,
    keyMode: KeyMode.Sequencer,
    requested: false,
    count: 3,
    result: [],
    votersCount: 10n,
    ready: false,
    secret: 0n,
    gateOpen: true,
    decryptionMode: 1,
    decryptionOpenAt: BigInt(NOW - 7300),
    fallbackAt: 0n,
    ...overrides,
  };
  const plaintextCalls: unknown[][] = [];
  const hooks: { finalizeRevert?: string; onFinalize?: () => void } = {};
  const key = state.keyMode === KeyMode.Sequencer ? bjjMulBase(5n) : bjjMulBase(7n);
  chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, {
    getProcess: () => [
      {
        status: state.status,
        organizationId: ORGANIZER,
        encryptionKey: { x: key.x, y: key.y },
        latestStateRoot: `0x${'04'.repeat(32)}`,
        result: state.result,
        startTime: BigInt(NOW - 7200),
        duration: 3600n,
        maxVoters: 100n,
        votersCount: state.votersCount,
        overwrittenVotesCount: 0n,
        creationBlock: 48_600_000n,
        batchNumber: 3n,
        metadataURI,
        metadataHash: sha256(bytes),
        ballotMode: modeOf({ type: 'single_choice' }, 3),
        census: {
          censusOrigin: 1,
          censusRoot: `0x${'00'.repeat(31)}05`,
          contractAddress: ZeroAddress,
          censusURI: 'https://files.example.org/census.json',
          onchainAllowAnyValidRoot: false,
        },
        keyMode: state.keyMode,
        dkgEpochId: state.keyMode === KeyMode.Sequencer ? `0x${'00'.repeat(12)}` : EPOCH,
        dkgFirstIndex: state.keyMode === KeyMode.Council ? 0 : 40,
        dkgCount: state.count,
        dkgZeroSkipped: 0,
        dkgResultsRequested: state.requested,
        dkgAid: state.keyMode === KeyMode.Sequencer ? `0x${'00'.repeat(32)}` : AID,
        grace: 180,
        lastVoteAt: 0n,
      },
    ],
    defaultGrace: () => [180],
    graceFloor: () => [150],
    graceCeil: () => [600],
    graceMaxTotal: () => [1800],
    noticeMin: () => [60],
    dkgAdapter: () => [ADAPTER],
    councilAdapter: () => [COUNCIL_ADAPTER],
    finalizeResultsFromDKG: () => {
      hooks.onFinalize?.();
      return hooks.finalizeRevert ? revertWith(PROCESS_REGISTRY_ABI, hooks.finalizeRevert) : [];
    },
  });
  chain.contract(ADAPTER, DAVINCI_DKG_ADAPTER_ABI, {
    appManager: () => [APP_MANAGER],
    plaintexts: args => {
      plaintextCalls.push([...args]);
      return [state.ready, state.ready ? [5n, 3n, 2n] : []];
    },
  });
  const councilCalls: unknown[][] = [];
  const gateCalls: unknown[][] = [];
  chain.contract(COUNCIL_ADAPTER, COUNCIL_ADAPTER_ABI, {
    plaintexts: args => {
      councilCalls.push([...args]);
      return [state.ready, [5n, 3n, 2n]];
    },
    isDecryptionOpen: args => {
      gateCalls.push([...args]);
      return [state.gateOpen];
    },
    manager: () => [COUNCIL_MANAGER],
  });
  const policyCalls: unknown[][] = [];
  chain.contract(COUNCIL_MANAGER, COUNCIL_POLICY_ABI, {
    getPolicy: args => {
      policyCalls.push([...args]);
      const manual = state.decryptionMode === 0;
      return [
        {
          registrationMode: 1,
          decryptionMode: state.decryptionMode,
          dealingDuration: 86_400n,
          decryptionOpenAt: manual ? 0n : state.decryptionOpenAt,
          manualDecryptionFallbackAt: manual ? state.fallbackAt : 0n,
          manualOpenedAt: 0n,
          decryptionOpen: state.gateOpen,
          scheduledRegistrationCloseDue: false,
        },
      ];
    },
  });
  chain.contract(APP_MANAGER, DKG_APP_MANAGER_ABI, {
    getApplication: () => [
      {
        creator: REGISTRY,
        organizerPK: { x: 1n, y: 2n },
        organizerSecret: state.secret,
        poolIndex: 3,
        policy: {
          mode: 0,
          openSubmission: false,
          submitters: [ADAPTER],
          maxCiphertexts: 16,
          notBeforeBlock: 0n,
          notAfterBlock: 0n,
          decryptNotBefore: 0n,
          decryptNotAfter: 0n,
        },
        createdAtBlock: 48_600_000n,
        exists: true,
      },
    ],
  });
  // Mining the nudge stores the tally.
  chain.onMine = tx => {
    if (iface.parseTransaction({ data: tx.data })?.name === 'finalizeResultsFromDKG') {
      state.status = ProcessStatus.RESULTS;
      state.result = [5n, 3n, 2n];
    }
    return { status: 1 };
  };
  const registry = new ProcessRegistryService(REGISTRY, chain);
  const api = new VocdoniApiService({ sequencerURLs: ['https://a.sequencer.test'] });
  const service = new VoteOrchestrationService(registry, api, wallet, {
    prove: () => Promise.reject(new Error('no proving here')),
    documents: { fetchImpl: host.fetchImpl },
    writer: () => new ProcessRegistryService(REGISTRY, wallet),
  });
  return {
    chain,
    state,
    service,
    registry,
    plaintextCalls,
    councilCalls,
    gateCalls,
    policyCalls,
    hooks,
  };
}

async function dkgOf(registry: ProcessRegistryService) {
  const { dkg } = await registry.getProcess(PID);
  if (!dkg) throw new Error('not a DKG process');
  return dkg;
}

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error
  );

describe('VoteOrchestrationService.getResultsStatus', () => {
  async function stateOf(overrides: Partial<Chain>, headTime = NOW): Promise<ResultsStatus> {
    const { service, chain } = setup(overrides);
    chain.headTime = headTime;
    return service.getResultsStatus(PID);
  }

  it('follows the timeline: voting, the grace window, then the key holder', async () => {
    expect((await stateOf({}, NOW - 5000)).state).toBe('voting');
    expect((await stateOf({ status: ProcessStatus.PAUSED }, NOW - 5000)).state).toBe('voting');
    const grace = await stateOf({}, NOW - 3500);
    expect(grace).toMatchObject({
      processId: PID,
      state: 'grace',
      keyMode: KeyMode.Sequencer,
      graceEnd: new Date((NOW - 3420) * 1000),
      chainTime: new Date((NOW - 3500) * 1000),
    });
    expect((await stateOf({})).state).toBe('awaiting-key-holder');
    expect((await stateOf({ status: ProcessStatus.ENDED })).state).toBe('awaiting-key-holder');
    expect((await stateOf({ status: ProcessStatus.CANCELED })).state).toBe('canceled');
  });

  it('decodes the tally once it is on-chain, with the verified metadata', async () => {
    const status = await stateOf({ status: ProcessStatus.RESULTS, result: [5n, 3n, 2n] });
    expect(status.state).toBe('results');
    expect(status.results?.kind).toBe('single_choice');
    expect(status.results?.questions[0].choices.map(c => [c.title, c.total, c.mean])).toEqual([
      ['North', 5n, 0.5],
      ['South', 3n, 0.3],
      ['East', 2n, 0.2],
    ]);
  });

  it('follows a DKG key: the request, the committee, the plaintexts', async () => {
    const dkg = { keyMode: KeyMode.DkgAutomatic, status: ProcessStatus.READY };
    expect((await stateOf(dkg)).state).toBe('awaiting-request');
    const requested = { ...dkg, status: ProcessStatus.ENDED, requested: true };
    const decrypting = setup(requested);
    expect((await decrypting.service.getResultsStatus(PID)).state).toBe('decrypting');
    expect(decrypting.plaintextCalls).toEqual([[EPOCH, AID, 40n, 3n]]);
    expect((await stateOf({ ...requested, ready: true })).state).toBe('finalizable');
    // Still inside the grace window, a DKG process is in its grace.
    expect((await stateOf(dkg, NOW - 3500)).state).toBe('grace');
  });

  it('follows a COUNCIL key like an automatic one, through the Council adapter', async () => {
    const council = { keyMode: KeyMode.Council, status: ProcessStatus.READY };
    expect((await stateOf(council, NOW - 3500)).state).toBe('grace');
    expect((await stateOf(council)).state).toBe('awaiting-request');
    const requested = { ...council, status: ProcessStatus.ENDED, requested: true };
    const decrypting = setup(requested);
    const status = await decrypting.service.getResultsStatus(PID);
    expect(status).toMatchObject({ state: 'decrypting', keyMode: KeyMode.Council });
    // The whole request from the Council adapter; the DKG adapter is never asked.
    expect(decrypting.councilCalls).toEqual([[EPOCH, AID, 0n, 3n]]);
    expect(decrypting.plaintextCalls).toEqual([]);
    expect((await stateOf({ ...requested, ready: true })).state).toBe('finalizable');
    expect(
      (await stateOf({ ...requested, status: ProcessStatus.RESULTS, result: [5n, 3n, 2n] })).state
    ).toBe('results');
  });

  it('keeps COUNCIL results locked until the ceremony opens decryption, zeros included', async () => {
    const OPENS = NOW + 182 * 86_400;
    const closed = {
      keyMode: KeyMode.Council,
      status: ProcessStatus.ENDED,
      gateOpen: false,
      decryptionOpenAt: BigInt(OPENS),
    };
    const waiting = setup(closed);
    const status = await waiting.service.getResultsStatus(PID);
    expect(status).toMatchObject({
      state: 'awaiting-opening',
      keyMode: KeyMode.Council,
      decryptionOpening: { mode: 'scheduled', opensAt: new Date(OPENS * 1000) },
    });
    expect(waiting.gateCalls).toEqual([[EPOCH]]);
    expect(waiting.policyCalls).toEqual([[EPOCH]]);
    // Nothing is asked of the committee while the gate is closed.
    expect(waiting.councilCalls).toEqual([]);
    // Requested, with active fields or none (an all-zero tally): still locked.
    expect((await stateOf({ ...closed, requested: true })).state).toBe('awaiting-opening');
    expect((await stateOf({ ...closed, requested: true, count: 0 })).state).toBe(
      'awaiting-opening'
    );
    // A manual opening: the organizer's, or the fallback date when there is one.
    expect(
      (await stateOf({ ...closed, decryptionMode: 0, fallbackAt: BigInt(OPENS) })).decryptionOpening
    ).toEqual({ mode: 'manual', opensAt: new Date(OPENS * 1000) });
    expect((await stateOf({ ...closed, decryptionMode: 0 })).decryptionOpening).toEqual({
      mode: 'manual',
      opensAt: null,
    });
    // Before the window closes the gate is not read.
    const early = setup(closed);
    early.chain.headTime = NOW - 3500;
    expect((await early.service.getResultsStatus(PID)).state).toBe('grace');
    expect(early.gateCalls).toEqual([]);

    // Open: the zero tally is finalizable at once, the others follow the committee.
    const open = { ...closed, gateOpen: true, requested: true };
    const zero = setup({ ...open, count: 0 });
    const opened = await zero.service.getResultsStatus(PID);
    expect(opened.state).toBe('finalizable');
    expect(opened.decryptionOpening).toBeUndefined();
    expect(zero.policyCalls).toEqual([]);
    expect((await stateOf(open)).state).toBe('decrypting');
    expect((await stateOf({ ...open, ready: true })).state).toBe('finalizable');
  });

  it('never reads the Council gate for the other key modes', async () => {
    for (const keyMode of [KeyMode.Sequencer, KeyMode.DkgAutomatic, KeyMode.DkgLocked]) {
      const other = setup({ keyMode, status: ProcessStatus.ENDED, gateOpen: false });
      expect((await other.service.getResultsStatus(PID)).state).not.toBe('awaiting-opening');
      expect(other.gateCalls).toEqual([]);
    }
  });

  it('says when a locked key is still sealed, and follows it once revealed', async () => {
    const locked = { keyMode: KeyMode.DkgLocked, status: ProcessStatus.ENDED, requested: true };
    expect((await stateOf(locked)).state).toBe('locked');
    expect((await stateOf({ ...locked, requested: false })).state).toBe('locked');
    expect((await stateOf({ ...locked, secret: 12345n })).state).toBe('decrypting');
    expect((await stateOf({ ...locked, secret: 12345n, ready: true })).state).toBe('finalizable');
    // Before the window closes, the reveal is not due yet.
    expect((await stateOf(locked, NOW - 3500)).state).toBe('grace');
  });
});

describe('ProcessRegistryService DKG reads', () => {
  it('reads the plaintexts and the reveal through the adapter', async () => {
    const { registry, plaintextCalls, state } = setup({ keyMode: KeyMode.DkgLocked });
    const dkg = await dkgOf(registry);
    expect(await registry.getDkgPlaintexts(dkg)).toEqual({ ready: false, values: [] });
    state.ready = true;
    expect(await registry.getDkgPlaintexts(dkg)).toEqual({ ready: true, values: [5n, 3n, 2n] });
    // No active field: nothing was submitted, so nothing is asked.
    expect(await registry.getDkgPlaintexts({ ...dkg, count: 0 })).toEqual({
      ready: true,
      values: [],
    });
    expect(plaintextCalls).toHaveLength(2);

    expect(await registry.isProcessKeyRevealed(dkg)).toBe(false);
    state.secret = 1n;
    expect(await registry.isProcessKeyRevealed(dkg)).toBe(true);
  });

  it('reads the Council decryption gate, and the policy only while it is closed', async () => {
    const { registry, state, gateCalls, policyCalls, chain } = setup({ keyMode: KeyMode.Council });
    const dkg = await dkgOf(registry);
    expect(await registry.getCouncilDecryptionGate(dkg)).toEqual({ open: true });
    expect(policyCalls).toEqual([]);
    state.gateOpen = false;
    state.decryptionOpenAt = 1_807_012_800n;
    expect(await registry.getCouncilDecryptionGate(dkg)).toEqual({
      open: false,
      mode: 'scheduled',
      opensAt: 1_807_012_800n,
    });
    state.decryptionMode = 0;
    expect(await registry.getCouncilDecryptionGate(dkg)).toEqual({
      open: false,
      mode: 'manual',
      opensAt: null,
    });
    expect(gateCalls).toHaveLength(3);
    // A DKG process has no Council gate: nothing is read.
    expect(await registry.getCouncilDecryptionGate({ ...dkg, council: false })).toEqual({
      open: true,
    });
    expect(gateCalls).toHaveLength(3);
    chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, { councilAdapter: () => [ZeroAddress] });
    await expect(registry.getCouncilDecryptionGate(dkg)).rejects.toThrow(CouncilDisabledError);
  });

  it('refuses them on a registry without DKG', async () => {
    const { chain, registry } = setup({ keyMode: KeyMode.DkgAutomatic });
    const dkg = await dkgOf(registry);
    chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, { dkgAdapter: () => [ZeroAddress] });
    await expect(registry.getDkgPlaintexts(dkg)).rejects.toThrow(DkgDisabledError);
    await expect(registry.isProcessKeyRevealed(dkg)).rejects.toThrow(DkgDisabledError);
  });
});

describe('VoteOrchestrationService.waitForResults', () => {
  it('waits through the states and returns the decoded tally', async () => {
    const { service, state } = setup();
    const seen: ResultsState[] = [];
    const done = service.waitForResults(PID, {
      pollIntervalMs: 1,
      onStatus: s => {
        seen.push(s.state);
      },
    });
    // The key holder publishes a few polls later.
    setTimeout(() => {
      state.status = ProcessStatus.RESULTS;
      state.result = [5n, 3n, 2n];
    }, 10);
    const results = await done;
    expect(seen).toEqual(['awaiting-key-holder', 'results']);
    expect(results.values).toEqual([5n, 3n, 2n]);
    expect(results.questions[0].choices[0]).toEqual({
      field: 0,
      title: 'North',
      total: 5n,
      mean: 0.5,
    });
  });

  it('names the Council opening date when it times out before it', async () => {
    const OPENS = NOW + 86_400;
    const { service } = setup({
      keyMode: KeyMode.Council,
      status: ProcessStatus.ENDED,
      requested: true,
      count: 0,
      gateOpen: false,
      decryptionOpenAt: BigInt(OPENS),
    });
    const err = await errorOf(service.waitForResults(PID, { timeoutMs: 10, pollIntervalMs: 2 }));
    expect(err).toBeInstanceOf(ResultsError);
    expect((err as ResultsError).reason).toBe('timeout');
    expect((err as ResultsError).status.state).toBe('awaiting-opening');
    expect(err?.message).toContain('has not opened decryption');
    expect(err?.message).toContain(new Date(OPENS * 1000).toISOString());
  });

  it('fails for a canceled process', async () => {
    const { service } = setup({ status: ProcessStatus.CANCELED });
    const err = await errorOf(service.waitForResults(PID));
    expect(err).toBeInstanceOf(ResultsError);
    expect((err as ResultsError).reason).toBe('canceled');
    expect((err as ResultsError).status.state).toBe('canceled');
  });

  it('fails for a sealed locked key, unless told to wait for the reveal', async () => {
    const locked = { keyMode: KeyMode.DkgLocked, status: ProcessStatus.ENDED, requested: true };
    const sealed = setup(locked);
    const err = await errorOf(sealed.service.waitForResults(PID));
    expect(err).toBeInstanceOf(ResultsError);
    expect((err as ResultsError).reason).toBe('locked');
    expect(err?.message).toContain('revealProcessKey');

    const patient = setup(locked);
    const seen: ResultsState[] = [];
    const done = patient.service.waitForResults(PID, {
      waitForReveal: true,
      pollIntervalMs: 1,
      onStatus: s => {
        seen.push(s.state);
        if (s.state === 'locked') {
          patient.state.secret = 99n;
        } else if (s.state === 'decrypting') {
          patient.state.status = ProcessStatus.RESULTS;
          patient.state.result = [1n, 1n, 1n];
        }
      },
    });
    expect((await done).values).toEqual([1n, 1n, 1n]);
    expect(seen).toEqual(['locked', 'decrypting', 'results']);
  });

  it('nudges a DKG finalize only when asked, after leaving the nodes their turn', async () => {
    const ready = {
      keyMode: KeyMode.DkgAutomatic,
      status: ProcessStatus.ENDED,
      requested: true,
      ready: true,
    };
    // Not asked: it waits, and sends nothing.
    const idle = setup(ready);
    const err = await errorOf(
      idle.service.waitForResults(PID, { timeoutMs: 20, pollIntervalMs: 5, finalizeAfterMs: 0 })
    );
    expect((err as ResultsError).reason).toBe('timeout');
    expect((err as ResultsError).status.state).toBe('finalizable');
    expect(idle.chain.sent).toHaveLength(0);

    const nudge = setup(ready);
    const started = Date.now();
    const results = await nudge.service.waitForResults(PID, {
      finalize: true,
      finalizeAfterMs: 30,
      pollIntervalMs: 5,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(results.values).toEqual([5n, 3n, 2n]);
    expect(nudge.chain.sent).toHaveLength(1);
    const tx = iface.parseTransaction({ data: nudge.chain.sent[0].data });
    expect(tx?.name).toBe('finalizeResultsFromDKG');
    expect(tx?.args[0]).toBe(PID);
  });

  it('takes a node that finalized first as done, and reports any other failure', async () => {
    const ready = {
      keyMode: KeyMode.DkgAutomatic,
      status: ProcessStatus.ENDED,
      requested: true,
      ready: true,
    };
    // Another node's finalize lands first: this one's simulation is refused.
    const raced = setup(ready);
    raced.hooks.finalizeRevert = 'InvalidStatus';
    raced.hooks.onFinalize = () => {
      raced.state.status = ProcessStatus.RESULTS;
      raced.state.result = [2n, 2n, 2n];
    };
    const results = await raced.service.waitForResults(PID, {
      finalize: true,
      finalizeAfterMs: 0,
      pollIntervalMs: 5,
    });
    expect(results.values).toEqual([2n, 2n, 2n]);
    expect(raced.chain.sent).toHaveLength(0);

    const broken = setup(ready);
    broken.hooks.finalizeRevert = 'InvalidKeyMode';
    const err = await errorOf(
      broken.service.waitForResults(PID, { finalize: true, finalizeAfterMs: 0, pollIntervalMs: 5 })
    );
    expect(err).toBeInstanceOf(ProcessResultError);
    expect((err as ProcessResultError).revertName).toBe('InvalidKeyMode');
  });

  it('keeps waiting through the margin after the grace end', async () => {
    const { service, state, chain } = setup();
    chain.headTime = NOW - 3420 + RESULTS_MARGIN_MS / 1000 - 5;
    setTimeout(() => {
      state.status = ProcessStatus.RESULTS;
      state.result = [1n, 2n, 3n];
    }, 10);
    expect((await service.waitForResults(PID, { pollIntervalMs: 1 })).values).toEqual([1n, 2n, 3n]);
  });

  it('waits until the grace window closes plus a margin by default', async () => {
    const { service, chain } = setup();
    chain.headTime = NOW - 3420 + RESULTS_MARGIN_MS / 1000 + 1;
    const err = await errorOf(service.waitForResults(PID, { pollIntervalMs: 1 }));
    expect((err as ResultsError).reason).toBe('timeout');
    expect((err as ResultsError).status.state).toBe('awaiting-key-holder');
    expect(err?.message).toBe(
      `process ${PID} has no results after the wait: ` +
        'only the node that issued the election key can publish them'
    );
  });
});
