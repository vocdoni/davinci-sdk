import { Interface, Wallet, ZeroAddress, concat, getBytes, hexlify, sha256 } from 'ethers';
import {
  CensusOrigin,
  CensusWitnessError,
  CspSigner,
  OffchainCensus,
  type CensusProviders,
  type MerkleCensus,
} from '../../../src/census';
import {
  LOG_BLOCK_RANGE,
  ONCHAIN_CENSUS_ABI,
  PROCESS_REGISTRY_ABI,
  ProcessRegistryService,
  ProcessStatus,
} from '../../../src/contracts';
import { VocdoniApiService } from '../../../src/core/api/ApiService';
import {
  NODE_MEMORY,
  VOTE_STATUS_MARGIN_MS,
  VoteError,
  VoteOrchestrationService,
  VoteReceiptError,
  type VoteErrorReason,
} from '../../../src/core/vote';
import {
  BN254_FR,
  addressToField,
  bjjMulBase,
  computeBallotInputsHash,
  isIdentityCiphertext,
  processIdToField,
  recoverVoteIdSigner,
  voteIdLeafHash,
  type BallotModeValues,
  type BjjPoint,
} from '../../../src/crypto';
import { BALLOT_VK_HASH } from '../../../src/protocol';
import {
  BallotProofError,
  BallotProver,
  verifyBallotProof,
  type BallotProof,
  type ProvableBallot,
} from '../../../src/prover';
import {
  SequencerApiError,
  SequencerDecodeError,
  SequencerErrorCode,
  VoteStatus,
  decodeVoteRequest,
  pickNode,
} from '../../../src/sequencer';
import { GNOSIS, computeProcessId } from '../../../src/networks';
import { RecentMap } from '../../../src/core/vote/recent';
import { MockChain } from '../../helpers/mockChain';
import { REAL_PROOF } from '../../helpers/realProof';

const REGISTRY = GNOSIS.processRegistry;
const ORGANIZER = `0x${'0a'.repeat(20)}`;
const PID = computeProcessId(ORGANIZER, '0x83f2e36e', 1);
const NOW = 1_700_000_000;
const URLS = ['https://a.sequencer.test', 'https://b.sequencer.test', 'https://c.sequencer.test'];
const KEY_POINT = bjjMulBase(12345n);
const VOTER = new Wallet(`0x${'22'.repeat(32)}`);
const A = '0x1111111111111111111111111111111111111111';
const B = '0x3333333333333333333333333333333333333333';
const CONTRACT = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const [FIRST, SECOND, THIRD] = pickNode(VOTER.address, PID, URLS);
// A ballot secret given by the caller: a full-width field element.
const K = 0x2f1e8d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeffn;
// Blocks: the process was created at CREATED, the head is HEAD.
const CREATED = 48_600_000;
const HEAD = 48_612_345;
const iface = new Interface(PROCESS_REGISTRY_ABI);

// One choice out of three.
const MODE: BallotModeValues = {
  numFields: 3,
  groupSize: 3,
  uniqueValues: false,
  costExponent: 1,
  maxValue: 1n,
  minValue: 0n,
  maxValueSum: 1n,
  minValueSum: 1n,
};

interface Election {
  status: ProcessStatus;
  startTime: bigint;
  duration: bigint;
  key: BjjPoint;
  mode: BallotModeValues;
  origin: CensusOrigin;
  root: string;
  contract: string;
  latestStateRoot: string;
  grace: number;
  lastVoteAt: bigint;
}

// The registry's `getProcess` struct of `e`.
function onchain(e: Election) {
  return {
    status: e.status,
    organizationId: ORGANIZER,
    encryptionKey: { x: e.key.x, y: e.key.y },
    latestStateRoot: e.latestStateRoot,
    result: [],
    startTime: e.startTime,
    duration: e.duration,
    maxVoters: 100n,
    votersCount: 0n,
    overwrittenVotesCount: 0n,
    creationBlock: BigInt(CREATED),
    batchNumber: 0n,
    metadataURI: '',
    metadataHash: `0x${'aa'.repeat(32)}`,
    ballotMode: { ...e.mode },
    census: {
      censusOrigin: e.origin,
      censusRoot: e.root,
      contractAddress: e.contract,
      censusURI: 'https://files.example.org/census.json',
      onchainAllowAnyValidRoot: false,
    },
    keyMode: 0,
    dkgEpochId: `0x${'00'.repeat(12)}`,
    dkgFirstIndex: 0,
    dkgCount: 0,
    dkgZeroSkipped: 0,
    dkgResultsRequested: false,
    dkgAid: `0x${'00'.repeat(32)}`,
    grace: e.grace,
    lastVoteAt: e.lastVoteAt,
  };
}

// A node's `GET /processes/{pid}` answer for `e`.
function viewOf(e: Election, overrides: Record<string, unknown> = {}) {
  const m = e.mode;
  return {
    id: PID,
    status: 'ready',
    isAcceptingVotes: true,
    organizationId: ORGANIZER,
    encryptionKey: { x: e.key.x.toString(), y: e.key.y.toString() },
    ballotMode: {
      numFields: m.numFields,
      groupSize: m.groupSize,
      uniqueValues: m.uniqueValues,
      costExponent: m.costExponent,
      maxValue: String(m.maxValue),
      minValue: String(m.minValue),
      maxValueSum: String(m.maxValueSum),
      minValueSum: String(m.minValueSum),
    },
    census: {
      censusOrigin: e.origin,
      censusRoot: BigInt(e.root).toString(),
      censusURI: 'https://files.example.org/census.json',
    },
    stateRoot: e.latestStateRoot,
    synced: true,
    votersCount: 0,
    overwrittenVotesCount: 0,
    maxVoters: 100,
    startTime: Number(e.startTime),
    duration: Number(e.duration),
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (code: number, error = `code ${code}`) =>
  json({ error, code }, Math.floor(code / 100));
const notFound = () => apiError(SequencerErrorCode.NotFound, 'not found');

async function participantOf(census: MerkleCensus, address: string) {
  const p = await census.proof(address);
  return {
    address: address.toLowerCase(),
    weight: census.getWeight(address),
    censusProof: {
      root: p.root.toString(),
      leaf: p.leaf.toString(),
      pathBits: Number(p.pathBits),
      siblings: p.siblings.map(String),
    },
  };
}

// A tracker proof of `voteId` with `levels` siblings, and the root it reaches.
function trackerProof(voteId: bigint, levels = 3) {
  const siblings = Array.from({ length: levels }, (_, i) =>
    hexlify(getBytes(sha256(new Uint8Array([i + 7]))))
  );
  let node = voteIdLeafHash(voteId);
  for (let i = levels - 1; i >= 0; i--) {
    const s = getBytes(siblings[i]);
    node = getBytes(sha256(concat((voteId >> BigInt(i)) & 1n ? [s, node] : [node, s])));
  }
  return {
    processId: PID,
    voteId: `0x${voteId.toString(16)}`,
    root: hexlify(node),
    siblings,
  };
}

type Reply = Response | 'down' | undefined;
type Route = (node: string, method: string, path: string, body: unknown) => Reply;

interface SetupOptions {
  origin?: CensusOrigin;
  census?: CensusProviders;
  routes?: Route[];
}

async function setup(options: SetupOptions = {}) {
  const census = new OffchainCensus();
  census.add([A, { key: VOTER.address, weight: 3 }, B]);
  const origin = options.origin ?? CensusOrigin.OffchainStatic;
  const root =
    origin === CensusOrigin.CSP
      ? `0x${'00'.repeat(12)}${(await CSP_SIGNER.address()).slice(2).toLowerCase()}`
      : origin === CensusOrigin.Onchain
        ? `0x${'00'.repeat(31)}07`
        : await census.root();
  const election: Election = {
    status: ProcessStatus.READY,
    startTime: BigInt(NOW - 100),
    duration: 3600n,
    key: KEY_POINT,
    mode: { ...MODE },
    origin,
    root,
    contract: origin === CensusOrigin.Onchain ? CONTRACT : ZeroAddress,
    latestStateRoot: `0x${'04'.repeat(32)}`,
    grace: 180,
    lastVoteAt: 0n,
  };
  const chain = new MockChain();
  chain.headTime = NOW;
  chain.headBlock = HEAD;
  chain.logRangeCap = LOG_BLOCK_RANGE;
  const state = { election, reads: 0, weights: new Map<string, bigint>([[VOTER.address, 9n]]) };
  chain.contract(REGISTRY, PROCESS_REGISTRY_ABI, {
    getProcess: () => {
      state.reads++;
      return [onchain(state.election)];
    },
    ballotVKHash: () => [BALLOT_VK_HASH],
    defaultGrace: () => [180],
    graceFloor: () => [150],
    graceCeil: () => [600],
    graceMaxTotal: () => [1800],
    noticeMin: () => [60],
  });
  chain.contract(CONTRACT, ONCHAIN_CENSUS_ABI, {
    weightOf: args => [state.weights.get(args[0] as string) ?? 0n],
  });

  const requests: { node: string; method: string; path: string; body: unknown }[] = [];
  const routes = options.routes ?? [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const node = url.origin;
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ node, method, path: url.pathname, body });
    for (const route of routes) {
      const reply = route(node, method, url.pathname, body);
      if (reply === 'down') return Promise.reject(new TypeError('fetch failed'));
      if (reply) return Promise.resolve(reply);
    }
    return defaults(node, method, url.pathname, body);
  }) as typeof fetch;

  const defaults = async (_node: string, method: string, path: string, body: unknown) => {
    const parts = path.split('/').filter(Boolean);
    if (method === 'POST' && path === '/votes') {
      return json({ voteId: (body as { voteId: string }).voteId });
    }
    if (parts[0] === 'processes' && parts.length === 2) return json(viewOf(state.election));
    if (parts[0] === 'processes' && parts[2] === 'participants') {
      const address = parts[3];
      return census.has(address) ? json(await participantOf(census, address)) : notFound();
    }
    if (parts[0] === 'votes' && parts[2] === 'voteId' && parts.length === 4) {
      return json({ status: 'pending' });
    }
    return notFound();
  };

  const registry = new ProcessRegistryService(REGISTRY, chain);
  const api = new VocdoniApiService({ sequencerURLs: URLS, sequencerConfig: { fetchImpl } });
  const proved: ProvableBallot[] = [];
  const prove = (ballot: ProvableBallot): Promise<BallotProof> => {
    proved.push(ballot);
    return Promise.resolve({
      proof: { ...REAL_PROOF.proof, curve: 'bn128' },
      publicSignals: ballot.publicSignals.map(String) as [string, string, string],
    });
  };
  const service = new VoteOrchestrationService(registry, api, VOTER, {
    prove,
    provider: chain,
    censusProviders: options.census,
  });
  const votes = () =>
    requests
      .filter(r => r.method === 'POST' && r.path === '/votes')
      .map(r => ({ node: r.node, vote: decodeVoteRequest(r.body) }));
  return { chain, state, census, requests, votes, proved, service, registry, api };
}

const CSP_WALLET = new Wallet(`0x${'33'.repeat(32)}`);
const CSP_SIGNER = new CspSigner(CSP_WALLET);

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error
  );

async function refusal(p: Promise<unknown>, reason: VoteErrorReason, message?: string) {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(VoteError);
  expect((err as VoteError).reason).toBe(reason);
  if (message) expect((err as VoteError).message).toContain(message);
  return err as VoteError;
}

describe('VoteOrchestrationService.submitVote', () => {
  it('builds the vote from the registry and sends it to the voter node', async () => {
    const { votes, proved, service, requests, state } = await setup();
    const result = await service.submitVote({ processId: PID, choices: [0, 1, 0], k: K });

    expect(result).toMatchObject({
      processId: PID,
      voterAddress: VOTER.address,
      status: VoteStatus.Pending,
      node: FIRST,
      weight: 3n,
      k: K,
    });
    expect(result.voteId).toMatch(/^0x[0-9a-f]{16}$/);

    // The node's view first, then the census proof, then the vote, all on the voter's node.
    expect(requests.map(r => `${r.node} ${r.method} ${r.path}`)).toEqual([
      `${FIRST} GET /processes/${PID}`,
      `${FIRST} GET /processes/${PID}/participants/${VOTER.address.toLowerCase()}`,
      `${FIRST} POST /votes`,
    ]);

    const [{ vote }] = votes();
    expect(vote.processId).toBe(PID);
    expect(vote.address.toLowerCase()).toBe(VOTER.address.toLowerCase());
    expect(`0x${vote.voteId.toString(16)}`).toBe(result.voteId);
    expect(vote.weight).toBe(3n);
    // A Merkle census proof is left out: nodes derive their own.
    expect(vote.censusProof).toBeUndefined();
    expect(vote.ballot).toHaveLength(16);
    expect(vote.ballot.slice(3).every(isIdentityCiphertext)).toBe(true);
    expect(vote.ballot.slice(0, 3).some(isIdentityCiphertext)).toBe(false);
    expect(vote.ballotProof.pi_a).toEqual(REAL_PROOF.proof.pi_a);
    expect(recoverVoteIdSigner(vote.voteId, vote.signature)).toBe(VOTER.address);
    // The inputs hash binds the registry's key, mode and the census weight.
    expect(vote.ballotInputsHash).toBe(
      await computeBallotInputsHash({
        processId: processIdToField(PID),
        ballotMode: state.election.mode,
        encryptionKey: KEY_POINT,
        address: addressToField(VOTER.address),
        voteId: vote.voteId,
        ballot: vote.ballot,
        weight: 3n,
      })
    );
    expect(proved[0].publicSignals).toEqual([
      addressToField(VOTER.address),
      vote.voteId,
      vote.ballotInputsHash,
    ]);
  });

  it('draws a fresh ballot secret each time, and takes the deprecated randomness', async () => {
    const { service } = await setup();
    const one = await service.submitVote({ processId: PID, choices: [1, 0, 0] });
    const two = await service.submitVote({ processId: PID, choices: [1, 0, 0] });
    expect(one.k).not.toBe(two.k);
    expect(one.voteId).not.toBe(two.voteId);
    const hex = await service.submitVote({
      processId: PID,
      choices: [1, 0, 0],
      randomness: `0x${K.toString(16)}`,
    });
    expect(hex.k).toBe(K);
    await expect(
      service.submitVote({ processId: PID, choices: [1], randomness: 'x' })
    ).rejects.toThrow('randomness');
  });

  it('refuses a ballot secret small enough to search for', async () => {
    const { service, requests } = await setup();
    for (const k of [0n, 1n, 1234n, BigInt(Date.now()), (1n << 128n) - 1n]) {
      await expect(service.submitVote({ processId: PID, choices: [1, 0, 0], k })).rejects.toThrow(
        'k is below 2^128'
      );
    }
    await expect(
      service.submitVote({ processId: PID, choices: [1, 0, 0], randomness: '4242' })
    ).rejects.toThrow('randomness is below 2^128');
    await expect(
      service.submitVote({ processId: PID, choices: [1, 0, 0], k: BN254_FR })
    ).rejects.toThrow(RangeError);
    // Nothing was asked of anyone.
    expect(requests).toHaveLength(0);
    expect(
      (await service.submitVote({ processId: PID, choices: [1, 0, 0], k: 1n << 128n })).k
    ).toBe(1n << 128n);
  });

  it('queues a revote on the node that took the previous ballot', async () => {
    let firstDown = true;
    const { service, votes } = await setup({
      routes: [
        (node, method) => (node === FIRST && method === 'POST' && firstDown ? 'down' : undefined),
      ],
    });
    const one = await service.submitVote({ processId: PID, choices: [1, 0, 0] });
    expect(one.node).toBe(SECOND);

    // The first node is back; the revote still goes behind the first ballot.
    firstDown = false;
    const two = await service.submitVote({ processId: PID, choices: [0, 1, 0] });
    expect(two.node).toBe(SECOND);

    // A node given by the app wins; one that is not configured is passed over.
    expect(
      (await service.submitVote({ processId: PID, choices: [0, 0, 1], node: THIRD })).node
    ).toBe(THIRD);
    expect(
      (await service.submitVote({ processId: PID, choices: [0, 0, 1], node: 'https://gone.test' }))
        .node
    ).toBe(THIRD);
    // The first vote was sent twice to the node that was down.
    expect(votes().map(v => v.node)).toEqual([FIRST, FIRST, SECOND, SECOND, THIRD, THIRD]);
  });

  it('refuses a process that takes no votes before proving anything', async () => {
    const { service, state, chain, proved, requests } = await setup();
    state.election.startTime = BigInt(NOW + 10);
    await refusal(
      service.submitVote({ processId: PID, choices: [1, 0, 0] }),
      'not-started',
      'opens at'
    );

    state.election.startTime = BigInt(NOW - 100);
    chain.headTime = NOW + 3500;
    await refusal(service.submitVote({ processId: PID, choices: [1, 0, 0] }), 'closed', 'ended at');

    chain.headTime = NOW;
    for (const status of [ProcessStatus.ENDED, ProcessStatus.CANCELED, ProcessStatus.RESULTS]) {
      state.election.status = status;
      await refusal(service.submitVote({ processId: PID, choices: [1, 0, 0] }), 'closed');
    }
    expect(proved).toHaveLength(0);
    expect(requests).toHaveLength(0);

    // A paused process still takes votes, from its start time on.
    state.election.status = ProcessStatus.PAUSED;
    state.election.startTime = BigInt(NOW);
    await service.submitVote({ processId: PID, choices: [1, 0, 0] });
    // One second before the end is still open.
    state.election.status = ProcessStatus.READY;
    chain.headTime = NOW + 3599;
    await service.submitVote({ processId: PID, choices: [1, 0, 0] });
  });

  it('refuses choices outside the ballot mode before proving', async () => {
    const { service, proved, votes } = await setup();
    await refusal(
      service.submitVote({ processId: PID, choices: [1, 1, 0] }),
      'invalid',
      'ballot mode'
    );
    await refusal(service.submitVote({ processId: PID, choices: [0, 0, 0] }), 'invalid');
    await refusal(service.submitVote({ processId: PID, choices: [0, 0, 0, 1] }), 'invalid');
    await refusal(
      service.submitVote({ processId: PID, choices: [0.5, 0, 0] }),
      'invalid',
      'integers'
    );
    expect(proved).toHaveLength(0);
    expect(votes()).toHaveLength(0);
  });

  it('refuses a node whose view is not the registry process', async () => {
    const other = bjjMulBase(999n);
    const { service, state, proved, votes } = await setup({
      routes: [
        (node, method, path) =>
          method === 'GET' && path === `/processes/${PID}`
            ? json(viewOf({ ...state.election, key: other }))
            : undefined,
      ],
    });
    const err = await errorOf(service.submitVote({ processId: PID, choices: [1, 0, 0] }));
    expect(err).toBeInstanceOf(SequencerDecodeError);
    expect(err?.message).toBe(
      `sequencer ${FIRST}: process view differs from the registry: encryption key`
    );
    expect((err as SequencerDecodeError).node).toBe(FIRST);
    expect(proved).toHaveLength(0);
    expect(votes()).toHaveLength(0);
  });

  it('checks the next node when one ignores the process, and names every reason', async () => {
    const ignored = (e: Election) =>
      json(viewOf(e, { ignored: true, note: 'census root mismatch' }));
    const { service, state, requests } = await setup({
      routes: [
        (node, method, path) =>
          node === FIRST && path === `/processes/${PID}` ? ignored(state.election) : undefined,
      ],
    });
    await service.submitVote({ processId: PID, choices: [1, 0, 0] });
    expect(requests.filter(r => r.path === `/processes/${PID}`).map(r => r.node)).toEqual([
      FIRST,
      SECOND,
    ]);

    const none = await setup({
      routes: [
        (node, method, path) =>
          path !== `/processes/${PID}`
            ? undefined
            : node === FIRST
              ? json(viewOf(none.state.election, { ignored: true, note: 'bad census' }))
              : apiError(SequencerErrorCode.UnknownProcess, 'unknown process'),
      ],
    });
    const err = await refusal(
      none.service.submitVote({ processId: PID, choices: [1, 0, 0] }),
      'unavailable'
    );
    expect(err.message).toBe(
      `no node serves process ${PID}: ${FIRST} ignores it: bad census; unknown process`
    );
    expect(err.code).toBe(SequencerErrorCode.UnknownProcess);
  });

  it('lets a node trail an updated census root, not a static one', async () => {
    const view = (e: Election, root: string, origin: number) =>
      json(
        viewOf(e, {
          census: { censusOrigin: origin, censusRoot: root, censusURI: 'https://x.test/c.json' },
        })
      );
    const lagging = await setup({
      origin: CensusOrigin.OffchainDynamic,
      routes: [
        (node, method, path) =>
          path === `/processes/${PID}` ? view(lagging.state.election, '5', 2) : undefined,
      ],
    });
    await lagging.service.submitVote({ processId: PID, choices: [1, 0, 0] });

    const pinned = await setup({
      routes: [
        (node, method, path) =>
          path === `/processes/${PID}` ? view(pinned.state.election, '5', 1) : undefined,
      ],
    });
    await expect(pinned.service.submitVote({ processId: PID, choices: [1, 0, 0] })).rejects.toThrow(
      'process view differs from the registry: census root'
    );
  });

  it('takes the census proof at the registry root, from the next node if needed', async () => {
    const other = new OffchainCensus();
    other.add([{ key: VOTER.address, weight: 5 }]);
    const stale = await participantOf(other, VOTER.address);

    // The first node answers from the previous census, the second is current.
    const behind = await setup({
      origin: CensusOrigin.OffchainDynamic,
      routes: [
        (node, method, path) =>
          node === FIRST && path.includes('/participants/') ? json(stale) : undefined,
      ],
    });
    expect((await behind.service.submitVote({ processId: PID, choices: [1, 0, 0] })).weight).toBe(
      3n
    );
    expect(behind.requests.filter(r => r.path.includes('/participants/')).map(r => r.node)).toEqual(
      [FIRST, SECOND]
    );

    // A node that is down is skipped as well.
    const down = await setup({
      routes: [
        (node, method, path) =>
          node === FIRST && path.includes('/participants/') ? 'down' : undefined,
      ],
    });
    expect((await down.service.submitVote({ processId: PID, choices: [1, 0, 0] })).weight).toBe(3n);

    // Every node on another root: nobody can tell.
    const allStale = await setup({
      routes: [(node, method, path) => (path.includes('/participants/') ? json(stale) : undefined)],
    });
    const err = await refusal(
      allStale.service.submitVote({ processId: PID, choices: [1, 0, 0] }),
      'unavailable',
      'has census root'
    );
    expect(err.cause).toBeInstanceOf(CensusWitnessError);
    expect(allStale.proved).toHaveLength(0);
  });

  it('says not in the census only when every node says so', async () => {
    const other = new OffchainCensus();
    other.add([{ key: VOTER.address, weight: 5 }]);
    const stale = await participantOf(other, VOTER.address);
    const participant = (path: string) => path.includes('/participants/');

    // The synced node is down and the others do not know the voter.
    const down = await setup({
      origin: CensusOrigin.OffchainDynamic,
      routes: [
        (node, method, path) =>
          !participant(path) ? undefined : node === SECOND ? 'down' : notFound(),
      ],
    });
    const err = await refusal(
      down.service.submitVote({ processId: PID, choices: [1, 0, 0] }),
      'unavailable',
      'no node could tell whether'
    );
    expect(err.node).toBe(SECOND);
    await expect(down.service.getAddressWeight(PID, VOTER.address)).rejects.toThrow(VoteError);
    await expect(down.service.isAddressAbleToVote(PID, VOTER.address)).rejects.toThrow(
      'fetch failed'
    );

    // One node trails the census, the others do not know the voter.
    const trailing = await setup({
      origin: CensusOrigin.OffchainDynamic,
      routes: [
        (node, method, path) =>
          !participant(path) ? undefined : node === THIRD ? json(stale) : notFound(),
      ],
    });
    await refusal(
      trailing.service.submitVote({ processId: PID, choices: [1, 0, 0] }),
      'unavailable'
    );

    // A node refusing the request itself is not an availability problem.
    const malformed = await setup({
      routes: [
        (node, method, path) =>
          participant(path) ? apiError(SequencerErrorCode.MalformedRequest) : undefined,
      ],
    });
    await expect(malformed.service.getAddressWeight(PID, VOTER.address)).rejects.toBeInstanceOf(
      SequencerApiError
    );

    // Every node answered: not a member.
    const none = await setup({
      routes: [(node, method, path) => (participant(path) ? notFound() : undefined)],
    });
    expect(await none.service.getAddressWeight(PID, VOTER.address)).toBe(0n);
    await refusal(none.service.submitVote({ processId: PID, choices: [1, 0, 0] }), 'not-in-census');
  });

  it('remembers a bounded number of voter nodes', () => {
    const recent = new RecentMap<string, string>(2);
    recent.set('a', '1');
    recent.set('b', '2');
    recent.set('a', '3'); // rewritten: now the newest
    recent.set('c', '4');
    expect([recent.get('a'), recent.get('b'), recent.get('c'), recent.size]).toEqual([
      '3',
      undefined,
      '4',
      2,
    ]);
    expect(() => new RecentMap(0)).toThrow('capacity 0');
    expect(NODE_MEMORY).toBe(1_000);
  });

  it('refuses a voter outside the census before proving', async () => {
    const { service, census, proved, votes } = await setup();
    census.remove(VOTER.address);
    await refusal(service.submitVote({ processId: PID, choices: [1, 0, 0] }), 'not-in-census');
    expect(proved).toHaveLength(0);
    expect(votes()).toHaveLength(0);
  });

  it('reads an on-chain census from its contract', async () => {
    const { service, state, votes, requests } = await setup({ origin: CensusOrigin.Onchain });
    expect((await service.submitVote({ processId: PID, choices: [0, 0, 1] })).weight).toBe(9n);
    expect(votes()[0].vote.weight).toBe(9n);
    expect(requests.some(r => r.path.includes('/participants/'))).toBe(false);

    state.weights.clear();
    await refusal(service.submitVote({ processId: PID, choices: [0, 0, 1] }), 'not-in-census');
  });

  it("sends a CSP census's attestation", async () => {
    const csp = (weight = 5n, address = VOTER.address) =>
      ({
        csp: request =>
          new CspSigner(CSP_WALLET).attest({
            processId: request.processId,
            address,
            weight,
            index: 4n,
          }),
      }) satisfies CensusProviders;
    const { service, votes } = await setup({ origin: CensusOrigin.CSP, census: csp() });
    const result = await service.submitVote({ processId: PID, choices: [1, 0, 0] });
    expect(result.weight).toBe(5n);
    const [{ vote }] = votes();
    expect(vote.weight).toBe(5n);
    expect(vote.censusProof).toMatchObject({ type: 'csp', index: 4n });

    const none = await setup({ origin: CensusOrigin.CSP });
    await expect(none.service.submitVote({ processId: PID, choices: [1, 0, 0] })).rejects.toThrow(
      'set censusProviders.csp'
    );
    // An attestation of another voter is refused before proving.
    const wrong = await setup({ origin: CensusOrigin.CSP, census: csp(5n, A) });
    await expect(wrong.service.submitVote({ processId: PID, choices: [1, 0, 0] })).rejects.toThrow(
      CensusWitnessError
    );
    expect(wrong.proved).toHaveLength(0);
  });

  it('uses a custom Merkle witness provider', async () => {
    const { service, requests } = await setup({
      census: { merkle: () => Promise.resolve({ type: 'merkle', weight: 3n }) },
    });
    await service.submitVote({ processId: PID, choices: [1, 0, 0] });
    expect(requests.some(r => r.path.includes('/participants/'))).toBe(false);
  });

  it('maps every node refusal to a vote error reason', async () => {
    const cases: [number | 'down', string, VoteErrorReason][] = [
      [SequencerErrorCode.DuplicateVote, 'vote 0x8 already submitted', 'duplicate'],
      [SequencerErrorCode.SlotBusy, 'slot 5 has too many queued votes', 'slot-busy'],
      [SequencerErrorCode.MalformedRequest, 'address not in the census', 'not-in-census'],
      [SequencerErrorCode.MalformedRequest, 'CSP census proof required', 'invalid'],
      [SequencerErrorCode.InvalidVote, 'inputs hash does not match the vote', 'invalid'],
      [SequencerErrorCode.NotAcceptingVotes, 'not accepting votes: ended', 'closed'],
      [SequencerErrorCode.MaxVotersReached, 'max voters reached', 'max-voters'],
      [SequencerErrorCode.NotStarted, 'not open yet: voting starts at 5', 'not-started'],
      [SequencerErrorCode.Busy, 'busy: census not loaded yet', 'busy'],
      [SequencerErrorCode.BodyTooLarge, 'request body too large', 'invalid'],
      [SequencerErrorCode.ObserverNode, 'observer node: no votes', 'unavailable'],
      ['down', 'fetch failed', 'unavailable'],
    ];
    for (const [code, text, reason] of cases) {
      const { service } = await setup({
        routes: [
          (node, method) =>
            method !== 'POST' ? undefined : code === 'down' ? 'down' : apiError(code, text),
        ],
      });
      const err = await refusal(service.submitVote({ processId: PID, choices: [1, 0, 0] }), reason);
      expect(err.message, text).toContain(text);
      expect(err.cause, text).toBeDefined();
      // Refusals come from the voter's node; no node taking it ends on the last one.
      expect(err.node, text).toBe(reason === 'unavailable' ? THIRD : FIRST);
      if (code !== 'down') expect(err.code, text).toBe(code);
    }
  });

  it('refuses a proof of other public signals', async () => {
    const chain = await setup();
    const service = new VoteOrchestrationService(chain.registry, chain.api, VOTER, {
      provider: chain.chain,
      prove: () =>
        Promise.resolve({
          proof: REAL_PROOF.proof,
          publicSignals: REAL_PROOF.public_signals as [string, string, string],
        }),
    });
    await expect(service.submitVote({ processId: PID, choices: [1, 0, 0] })).rejects.toThrow(
      BallotProofError
    );
    expect(chain.votes()).toHaveLength(0);
  });
});

describe('VoteOrchestrationService vote status', () => {
  const VID = '0x8000000000000abc';
  const statusPath = `/votes/${PID}/voteId/${VID}`;

  // Each node answers the status requests from its own list, then 404.
  function statuses(script: Record<string, (Response | 'down')[]>): Route {
    return (node, method, path) => {
      if (path !== statusPath) return undefined;
      return script[node]?.shift() ?? notFound();
    };
  }

  it('asks the node that took the vote first, and reports the answering node', async () => {
    const { service, requests } = await setup({
      routes: [statuses({ [SECOND]: [json({ status: 'error', error: 'process closed' })] })],
    });
    const info = await service.getVoteStatus(PID, VID, SECOND);
    expect(info).toEqual({
      voteId: VID,
      status: VoteStatus.Error,
      error: 'process closed',
      processId: PID,
      node: SECOND,
    });
    expect(requests.map(r => r.node)).toEqual([SECOND]);

    // The node this service sent the vote to is the default.
    const sent = await setup();
    const { voteId, node } = await sent.service.submitVote({ processId: PID, choices: [1, 0, 0] });
    sent.requests.length = 0;
    expect((await sent.service.getVoteStatus(PID, voteId)).node).toBe(node);
    expect(sent.requests.map(r => r.node)).toEqual([node]);
  });

  it('follows a vote until its target or a later step, yielding each change', async () => {
    const { service } = await setup({
      routes: [
        statuses({
          [URLS[0]]: [
            json({ status: 'pending' }),
            json({ status: 'pending' }),
            json({ status: 'aggregated' }),
            json({ status: 'settled' }),
          ],
        }),
      ],
    });
    const seen: string[] = [];
    for await (const s of service.watchVoteStatus(PID, VID, {
      targetStatus: VoteStatus.Processed,
      pollIntervalMs: 1,
    })) {
      seen.push(s.status);
    }
    expect(seen).toEqual(['pending', 'aggregated', 'settled']);
  });

  it('ends a wait on an error, with its reason', async () => {
    const { service } = await setup({
      routes: [
        statuses({
          [URLS[0]]: [
            json({ status: 'pending' }),
            json({ status: 'error', error: 'census changed, recast' }),
          ],
        }),
      ],
    });
    const last = await service.waitForVoteStatus(PID, VID, { pollIntervalMs: 1 });
    expect(last).toMatchObject({ status: 'error', error: 'census changed, recast' });
  });

  it('waits until the grace window closes by default, following it as it moves', async () => {
    const pending = () => json({ status: 'pending' });
    // The grace window closed more than the margin ago: one read, then the timeout.
    const late = await setup({ routes: [statuses({ [URLS[0]]: [pending(), pending()] })] });
    // End NOW + 3500, grace 180.
    late.chain.headTime = NOW + 3680 + VOTE_STATUS_MARGIN_MS / 1000 + 1;
    const err = await refusal(
      late.service.waitForVoteStatus(PID, VID, { pollIntervalMs: 1 }),
      'timeout',
      'is pending, not settled'
    );
    expect(err.node).toBe(URLS[0]);

    // The organizer extended the process meanwhile: the wait goes on.
    const extended = await setup({
      routes: [
        (node, method, path) => {
          if (path === statusPath) extended.state.election.duration = 36_000n;
          return undefined;
        },
        statuses({ [URLS[0]]: [pending(), json({ status: 'settled' })] }),
      ],
    });
    extended.chain.headTime = NOW + 3680 + VOTE_STATUS_MARGIN_MS / 1000 + 1;
    const last = await extended.service.waitForVoteStatus(PID, VID, { pollIntervalMs: 1 });
    expect(last.status).toBe('settled');
    // At the start, and again once the first deadline passed.
    expect(extended.state.reads).toBe(2);
  });

  it('keeps waiting through the margin after the grace end', async () => {
    const { service, chain } = await setup({
      routes: [statuses({ [URLS[0]]: [json({ status: 'pending' }), json({ status: 'settled' })] })],
    });
    // The window closed a minute ago: nodes may still report the last landings.
    chain.headTime = NOW + 3680 + 60;
    const last = await service.waitForVoteStatus(PID, VID, { pollIntervalMs: 1 });
    expect(last.status).toBe('settled');
  });

  it('gives up after an explicit timeout', async () => {
    const { service } = await setup({
      routes: [
        (node, method, path) => (path === statusPath ? json({ status: 'pending' }) : undefined),
      ],
    });
    await refusal(
      service.waitForVoteStatus(PID, VID, { timeoutMs: 20, pollIntervalMs: 5 }),
      'timeout'
    );
  });
});

describe('VoteOrchestrationService.getVoteReceipt', () => {
  const vid = 0x8000000000000abcn;
  const VID = '0x8000000000000abc';
  const proofPath = `/votes/${PID}/voteId/${VID}/proof`;
  const tracker = trackerProof(vid);

  function transitioned(root: string, block = HEAD - 1_000) {
    const { topics, data } = iface.encodeEventLog('ProcessStateTransitioned', [
      PID,
      A,
      `0x${'01'.repeat(32)}`,
      root,
      1n,
      0n,
      1n,
    ]);
    return { address: REGISTRY, topics, data, block };
  }

  it("checks the proof against the registry's latest state root", async () => {
    const { service, state } = await setup({
      routes: [
        (node, method, path) =>
          path !== proofPath ? undefined : node === URLS[0] ? notFound() : json(tracker),
      ],
    });
    state.election.latestStateRoot = tracker.root;
    const receipt = await service.getVoteReceipt(PID, VID);
    expect(receipt).toMatchObject({
      processId: PID,
      voteId: VID,
      root: tracker.root,
      latest: true,
      node: URLS[1],
    });
    expect(receipt.proof.voteId).toBe(vid);
  });

  it('reads the proof again when a transition landed in between', async () => {
    let answers = 0;
    const { service, state } = await setup({
      routes: [
        (node, method, path) => {
          if (path !== proofPath) return undefined;
          // The node's first proof is for the root before the latest.
          if (answers++ === 0) return json(trackerProof(vid, 2));
          return json(tracker);
        },
      ],
    });
    state.election.latestStateRoot = tracker.root;
    expect((await service.getVoteReceipt(PID, VID)).latest).toBe(true);
    expect(answers).toBe(2);
  });

  it("accepts an earlier root from the process's transitions", async () => {
    const { service, state, chain } = await setup({
      routes: [(node, method, path) => (path === proofPath ? json(tracker) : undefined)],
    });
    state.election.latestStateRoot = `0x${'0f'.repeat(32)}`;
    const ranges = () =>
      chain.calls('eth_getLogs').map(c => {
        const f = (c.params as { fromBlock: string; toBlock: string }[])[0];
        return [Number(f.fromBlock), Number(f.toBlock)];
      });

    // A recent root: the newest window has it, and nothing older is read.
    chain.logs = [transitioned(`0x${'0e'.repeat(32)}`), transitioned(tracker.root)];
    const receipt = await service.getVoteReceipt(PID, VID);
    expect(receipt).toMatchObject({ root: tracker.root, latest: false, blockNumber: HEAD - 1_000 });
    expect(receipt.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ranges()).toEqual([[HEAD - LOG_BLOCK_RANGE + 1, HEAD]]);

    // An old root: windows the RPC accepts, back to the creation block.
    chain.requests.length = 0;
    chain.logs = [transitioned(tracker.root, CREATED + 3)];
    expect((await service.getVoteReceipt(PID, VID)).blockNumber).toBe(CREATED + 3);
    expect(ranges()).toEqual([
      [HEAD - LOG_BLOCK_RANGE + 1, HEAD],
      [HEAD - 2 * LOG_BLOCK_RANGE + 1, HEAD - LOG_BLOCK_RANGE],
      [CREATED, HEAD - 2 * LOG_BLOCK_RANGE],
    ]);
  });

  it('refuses a proof that reaches no root of the process', async () => {
    const { service, state, chain } = await setup({
      routes: [(node, method, path) => (path === proofPath ? json(tracker) : undefined)],
    });
    state.election.latestStateRoot = `0x${'0f'.repeat(32)}`;
    chain.logs = [transitioned(`0x${'0e'.repeat(32)}`)];
    const err = await errorOf(service.getVoteReceipt(PID, VID));
    expect(err).toBeInstanceOf(VoteReceiptError);
    expect((err as VoteReceiptError).node).toBe(URLS[0]);

    // A proof that names a root of the history must reach it too.
    const off = { ...tracker, siblings: [...tracker.siblings.slice(1), tracker.siblings[0]] };
    const walked = await setup({
      routes: [(node, method, path) => (path === proofPath ? json(off) : undefined)],
    });
    walked.state.election.latestStateRoot = `0x${'0f'.repeat(32)}`;
    walked.chain.logs = [transitioned(tracker.root)];
    await expect(walked.service.getVoteReceipt(PID, VID)).rejects.toThrow('does not reach');

    // A proof that names the latest root must reach it.
    const tampered = { ...tracker, siblings: [...tracker.siblings.slice(1), tracker.siblings[0]] };
    const bad = await setup({
      routes: [(node, method, path) => (path === proofPath ? json(tampered) : undefined)],
    });
    bad.state.election.latestStateRoot = tracker.root;
    await expect(bad.service.getVoteReceipt(PID, VID)).rejects.toThrow('does not reach');
    expect(bad.chain.calls('eth_getLogs')).toHaveLength(0);
  });

  it('says when no node holds the vote yet', async () => {
    const { service } = await setup();
    const err = await errorOf(service.getVoteReceipt(PID, VID));
    expect(err).toBeInstanceOf(VoteReceiptError);
    expect(err?.message).toBe(`no node holds vote ${VID} in its tree yet: it has not settled`);
    expect((err as VoteReceiptError).cause).toBeInstanceOf(SequencerApiError);
  });
});

describe('VoteOrchestrationService census reads', () => {
  const ballotPath = `/votes/${PID}/address/${VOTER.address.toLowerCase()}`;
  const stored = () =>
    json({
      address: VOTER.address.toLowerCase(),
      ballot: Array.from({ length: 16 }, () => ({
        c1: { x: '0', y: '1' },
        c2: { x: '0', y: '1' },
      })),
    });

  // Each node's answer for the voter's slot.
  function slots(answers: Record<string, 'held' | 'empty' | 'down'>): Route {
    return (node, method, path) => {
      if (path !== ballotPath) return undefined;
      const a = answers[node];
      return a === 'held' ? stored() : a === 'down' ? 'down' : notFound();
    };
  }

  it('says a Merkle voter has voted when any node holds the ballot', async () => {
    const held = await setup({
      routes: [slots({ [URLS[0]]: 'empty', [URLS[1]]: 'down', [URLS[2]]: 'held' })],
    });
    expect(await held.service.hasAddressVoted(PID, VOTER.address)).toBe(true);
    // Every node is asked.
    expect(held.requests.filter(r => r.path === ballotPath)).toHaveLength(3);

    const empty = await setup({
      routes: [slots({ [URLS[0]]: 'empty', [URLS[1]]: 'down', [URLS[2]]: 'down' })],
    });
    expect(await empty.service.hasAddressVoted(PID, VOTER.address)).toBe(false);

    const down = await setup({
      routes: [slots({ [URLS[0]]: 'down', [URLS[1]]: 'down', [URLS[2]]: 'down' })],
    });
    await expect(down.service.hasAddressVoted(PID, VOTER.address)).rejects.toThrow('fetch failed');
  });

  it('needs every node to answer for a CSP voter', async () => {
    const origin = CensusOrigin.CSP;
    const held = await setup({
      origin,
      routes: [slots({ [URLS[0]]: 'down', [URLS[1]]: 'held', [URLS[2]]: 'down' })],
    });
    expect(await held.service.hasAddressVoted(PID, VOTER.address)).toBe(true);

    const all = await setup({ origin, routes: [slots({})] });
    expect(await all.service.hasAddressVoted(PID, VOTER.address)).toBe(false);

    // The node that did not answer may be the one that took the ballot.
    const unsure = await setup({ origin, routes: [slots({ [URLS[1]]: 'down' })] });
    await expect(unsure.service.hasAddressVoted(PID, VOTER.address)).rejects.toThrow(
      'fetch failed'
    );
  });

  it('reads the weight of a Merkle member from the nodes, 0 for anyone else', async () => {
    const { service, census } = await setup();
    expect(await service.getAddressWeight(PID, VOTER.address)).toBe(3n);
    expect(await service.isAddressAbleToVote(PID, VOTER.address.toLowerCase())).toBe(true);
    expect(await service.getAddressWeight(PID, B)).toBe(1n);
    census.remove(B);
    expect(await service.getAddressWeight(PID, B)).toBe(0n);
    expect(await service.isAddressAbleToVote(PID, B)).toBe(false);
  });

  it('reads an on-chain census from its contract', async () => {
    const { service, requests } = await setup({ origin: CensusOrigin.Onchain });
    expect(await service.getAddressWeight(PID, VOTER.address)).toBe(9n);
    expect(await service.isAddressAbleToVote(PID, A)).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('asks the CSP for a CSP census, and checks what it signs', async () => {
    const attest = (address: string, weight: bigint) =>
      new CspSigner(CSP_WALLET).attest({ processId: PID, address, weight, index: 2n });
    const good = await setup({
      origin: CensusOrigin.CSP,
      census: { csp: r => attest(r.address, 6n) },
    });
    expect(await good.service.getAddressWeight(PID, VOTER.address)).toBe(6n);
    expect(await good.service.isAddressAbleToVote(PID, VOTER.address)).toBe(true);

    const rogue = await setup({
      origin: CensusOrigin.CSP,
      census: {
        csp: r =>
          new CspSigner(Wallet.createRandom()).attest({ processId: PID, address: r.address }),
      },
    });
    await expect(rogue.service.isAddressAbleToVote(PID, VOTER.address)).rejects.toThrow(
      CensusWitnessError
    );

    const none = await setup({ origin: CensusOrigin.CSP });
    await expect(none.service.getAddressWeight(PID, VOTER.address)).rejects.toThrow(
      'set censusProviders.csp'
    );
  });
});

// The real circuit files (DAVINCI_CIRCUIT_ARTIFACTS=/path/to/davinci-circom/artifacts).
const DIR = process.env.DAVINCI_CIRCUIT_ARTIFACTS;

describe.skipIf(!DIR)('VoteOrchestrationService with the real ballot prover', () => {
  afterAll(async () => {
    await BallotProver.terminate();
  });

  it('casts a vote whose proof the node verifies under the pinned key', async () => {
    const { registry, api, votes, chain } = await setup();
    const prover = new BallotProver({ artifacts: { dir: DIR } });
    const service = new VoteOrchestrationService(registry, api, VOTER, {
      provider: chain,
      prove: ballot => prover.prove(ballot, BALLOT_VK_HASH),
    });
    await service.submitVote({ processId: PID, choices: [0, 0, 1] });
    const [{ vote }] = votes();
    const signals = [addressToField(VOTER.address), vote.voteId, vote.ballotInputsHash];
    expect(await verifyBallotProof(REAL_PROOF.vk, vote.ballotProof, signals)).toBe(true);
  }, 120_000);
});
