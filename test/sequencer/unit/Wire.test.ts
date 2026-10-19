import {
  BJJ_IDENTITY,
  IDENTITY_CIPHERTEXT,
  LeanIMT,
  bjjMulBase,
  censusLeaf,
  elgamalEncrypt,
  verifyTrackerProof,
  type Ballot,
} from '../../../src/crypto';
import {
  CensusProofWire,
  VoteRequest,
  VoteStatus,
  checkProcessView,
  decodeCensusFile,
  decodeVoteRequest,
  encodeCensusFile,
  encodeVoteRequest,
  formatVoteId,
  normalizeProcessId,
  parseVoteId,
} from '../../../src/sequencer/api';
import {
  decodeBallotResponse,
  decodeBlobs,
  decodeEncryptionKey,
  decodeInfo,
  decodeParticipant,
  decodeProcessView,
  decodeTrackerProof,
  decodeTransitions,
  decodeVoteStatus,
} from '../../../src/sequencer/api/wire';
import { SequencerDecodeError } from '../../../src/sequencer/errors';
import { KeyMode, ProcessStatus, type OnchainProcess } from '../../../src/contracts/types';
import { CensusOrigin } from '../../../src/census/types';
import { readFixture } from '../../helpers/fixtures';

// Vectors: test/fixtures/sequencer/wire.json, the samples of davinci-sequencer
// client/tests/api.rs serialized by `davinci_client::api` at b109a4d, and the
// strict-decoding verdict of the same types for every edited copy (generator
// in test/fixtures/sequencer/wire-gen).
type Json = unknown;
type Path = (string | number)[];
type Op =
  | { op: 'set'; path: Path; value: Json }
  | { op: 'remove'; path: Path }
  | { op: 'pop'; path: Path }
  | { op: 'push'; path: Path; value: Json };
interface Case {
  label: string;
  ops: Op[];
  ok: boolean;
}
interface Wire {
  voteRequest: { merkle: Json; csp: Json; noCensusProof: Json };
  voteRequestCases: Case[];
  cspRequestCases: Case[];
  processView: { ready: Json; results: Json };
  processViewCases: Case[];
  info: { sequencer: Json; observer: Json };
  infoCases: Case[];
  encryptionKey: Json;
  encryptionKeyCases: Case[];
  voteStatuses: string[];
  voteStatusCases: { json: Json; ok: boolean }[];
  trackerProof: Json;
  trackerProofCases: Case[];
  participant: Json;
  participantCases: Case[];
  ballot: Json;
  ballotCases: Case[];
  transitions: Json;
  transitionCases: Case[];
  blobs: Json;
  blobCases: Case[];
  censusFile: Json;
  censusFileCases: Case[];
}

// Plain JSON.parse: the one integer past 2^53 (a numeric vote id) is refused either way.
const wire = JSON.parse(readFixture('sequencer/wire.json')) as Wire;

type Container = Record<string, unknown> | unknown[];

function walk(doc: Json, path: Path): Container {
  let v = doc as Container;
  for (const k of path) v = (v as Record<string | number, unknown>)[k] as Container;
  return v;
}

function applyOps(base: Json, ops: Op[]): Json {
  let doc = structuredClone(base);
  for (const op of ops) {
    if (op.op === 'set' && op.path.length === 0) {
      doc = structuredClone(op.value);
      continue;
    }
    const parentPath = op.path.slice(0, -1);
    const last = op.path[op.path.length - 1];
    switch (op.op) {
      case 'set':
        (walk(doc, parentPath) as Record<string | number, unknown>)[last] = structuredClone(
          op.value
        );
        break;
      case 'remove':
        delete (walk(doc, parentPath) as Record<string, unknown>)[last as string];
        break;
      case 'pop':
        (walk(doc, op.path) as unknown[]).pop();
        break;
      case 'push':
        (walk(doc, op.path) as unknown[]).push(structuredClone(op.value));
        break;
    }
  }
  return doc;
}

function accepts(decode: (json: unknown) => unknown, json: Json): boolean {
  try {
    decode(json);
    return true;
  } catch (err) {
    expect(err).toBeInstanceOf(SequencerDecodeError);
    return false;
  }
}

function expectVerdicts(base: Json, cases: Case[], decode: (json: unknown) => unknown) {
  expect(cases.length).toBeGreaterThan(1);
  for (const c of cases) {
    expect(accepts(decode, applyOps(base, c.ops)), c.label).toBe(c.ok);
  }
}

// The samples of client/tests/api.rs.
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const pk = bjjMulBase(12345n);

function sampleBallot(): Ballot {
  const b: Ballot = Array.from({ length: 16 }, () => ({ ...IDENTITY_CIPHERTEXT }));
  b[0] = elgamalEncrypt(pk, 3n, 77n);
  b[1] = elgamalEncrypt(pk, 1n, 78n);
  return b;
}

const sampleProof = {
  pi_a: ['1', '2', '1'] as [string, string, string],
  pi_b: [
    ['1', '2'],
    ['3', '4'],
    ['1', '0'],
  ] as [[string, string], [string, string], [string, string]],
  pi_c: ['5', '6', '1'] as [string, string, string],
  protocol: 'groth16',
  curve: 'bn128',
};

const addr = (b: number) => `0x${b.toString(16).padStart(2, '0').repeat(20)}`;

function merkleWire(): CensusProofWire {
  const leaves = [0, 1, 2, 3, 4].map(i => censusLeaf(addr(i), 1n));
  return { type: 'merkle', ...new LeanIMT(leaves).proof(3) };
}

const cspWire: CensusProofWire = {
  type: 'csp',
  r: `0x${'01'.repeat(32)}`,
  s: `0x${'02'.repeat(32)}`,
  recid: 1,
  index: 9n,
};

function sampleVote(censusProof?: CensusProofWire): VoteRequest {
  return {
    processId: `0x${'ab'.repeat(31)}`,
    address: addr(0x11),
    voteId: 0x8000000000001234n,
    ballot: sampleBallot(),
    ballotProof: sampleProof,
    signature: `0x${'07'.repeat(65)}`,
    weight: 42n,
    ...(censusProof && { censusProof }),
  };
}

// The JSON text of a value, as the node reads it.
const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v)) as unknown;

describe('vote request wire', () => {
  it('encodes byte for byte like the sequencer client', () => {
    const merkle = sampleVote(merkleWire());
    expect(asJson(encodeVoteRequest(merkle))).toEqual(wire.voteRequest.merkle);
    expect(asJson(encodeVoteRequest(sampleVote(cspWire)))).toEqual(wire.voteRequest.csp);
    const bare = asJson(encodeVoteRequest(sampleVote()));
    expect(bare).toEqual(wire.voteRequest.noCensusProof);
    expect(Object.keys(bare as object)).toHaveLength(7);
  });

  it('writes the fields in the order of the node types, without an inputs hash', () => {
    const j = encodeVoteRequest(sampleVote(merkleWire()));
    expect(Object.keys(j)).toEqual([
      'processId',
      'address',
      'voteId',
      'ballot',
      'ballotProof',
      'signature',
      'weight',
      'censusProof',
    ]);
    expect(j.voteId).toBe('0x8000000000001234');
    expect(j.weight).toBe('42');
    const ballot = j.ballot as unknown[];
    expect(ballot).toHaveLength(16);
    expect(ballot[15]).toEqual({ c1: { x: '0', y: '1' }, c2: { x: '0', y: '1' } });
    // Census values: `0x` and 64 lowercase hex digits.
    const proof = j.censusProof as { type: string; root: string; leaf: string; siblings: string[] };
    expect(proof.type).toBe('merkle');
    for (const v of [proof.root, proof.leaf, ...proof.siblings]) {
      expect(v).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('refuses an SDK 4 vote, which carries the inputs hash', () => {
    const old = { ...(wire.voteRequest.merkle as object), ballotInputsHash: '999' };
    expect(() => decodeVoteRequest(old)).toThrow('unknown field ballotInputsHash');
  });

  it('carries census values at and above the BN254 modulus unreduced', () => {
    const top = (1n << 256n) - 1n;
    const good = sampleVote(merkleWire());
    const proof = good.censusProof as CensusProofWire & { type: 'merkle' };
    const above = {
      ...good,
      censusProof: { ...proof, root: top, siblings: [P, ...proof.siblings] },
    };
    const j = encodeVoteRequest(above);
    const wired = j.censusProof as { root: string; siblings: string[] };
    expect(wired.root).toBe(`0x${'ff'.repeat(32)}`);
    expect(BigInt(wired.siblings[0])).toBe(P);
    expect(decodeVoteRequest(asJson(j))).toEqual({ ...above, address: addr(0x11) });
  });

  it('decodes back to the same vote', () => {
    const merkle = sampleVote(merkleWire());
    const back = decodeVoteRequest(wire.voteRequest.merkle);
    expect(back).toEqual({ ...merkle, address: '0x1111111111111111111111111111111111111111' });
    expect(asJson(encodeVoteRequest(back))).toEqual(wire.voteRequest.merkle);
    const csp = decodeVoteRequest(wire.voteRequest.csp);
    expect(csp.censusProof).toEqual(cspWire);
    expect(decodeVoteRequest(wire.voteRequest.noCensusProof).censusProof).toBeUndefined();
  });

  it('refuses every encoding the node refuses and nothing else', () => {
    expectVerdicts(wire.voteRequest.merkle, wire.voteRequestCases, decodeVoteRequest);
    expectVerdicts(wire.voteRequest.csp, wire.cspRequestCases, decodeVoteRequest);
  });

  it('never writes what the node would refuse', () => {
    const good = sampleVote(merkleWire());
    const proof = good.censusProof as CensusProofWire;
    const bad: [string, VoteRequest][] = [
      ['vote id below 2^63', { ...good, voteId: 0x7fffffffffffffffn }],
      ['vote id of 9 bytes', { ...good, voteId: 1n << 64n }],
      ['15 ciphertexts', { ...good, ballot: good.ballot.slice(1) }],
      [
        'off-curve point',
        {
          ...good,
          ballot: [{ c1: { x: 5n, y: 1n }, c2: BJJ_IDENTITY }, ...good.ballot.slice(1)],
        },
      ],
      ['weight 2^128', { ...good, weight: 1n << 128n }],
      ['31-byte process id', { ...good, processId: `0x${'ab'.repeat(30)}` }],
      ['short signature', { ...good, signature: `0x${'07'.repeat(64)}` }],
      ['index past 2^53', { ...good, censusProof: { ...cspWire, index: 1n << 53n } }],
      ['recid 256', { ...good, censusProof: { ...cspWire, recid: 256 } }],
      ['root 2^256', { ...good, censusProof: { ...proof, root: 1n << 256n } as never }],
      ['negative leaf', { ...good, censusProof: { ...proof, leaf: -1n } as never }],
      ['sibling 2^256', { ...good, censusProof: { ...proof, siblings: [1n << 256n] } as never }],
    ];
    for (const [label, v] of bad) {
      expect(() => encodeVoteRequest(v), label).toThrow(RangeError);
    }
  });
});

describe('response wire', () => {
  it('decodes a process view and checks its ballot mode and key', () => {
    const v = decodeProcessView(wire.processView.ready);
    expect(v.id).toBe(`0x${'03'.repeat(31)}`);
    expect(v.status).toBe('ready');
    expect(v.isAcceptingVotes).toBe(true);
    expect(v.encryptionKey).toEqual(pk);
    expect(v.ballotMode).toEqual({
      numFields: 4,
      groupSize: 1,
      uniqueValues: false,
      costExponent: 1,
      maxValue: 5n,
      minValue: 0n,
      maxValueSum: 1n << 62n,
      minValueSum: 0n,
    });
    expect(v.census).toEqual({
      censusOrigin: 1,
      censusRoot: BigInt(`0x${'05'.repeat(32)}`),
      censusURI: 'file:///tmp/census.json',
    });
    const above = {
      ...(wire.processView.ready as object),
      census: { censusOrigin: 1, censusRoot: `0x${'ee'.repeat(32)}`, censusURI: 'x' },
    };
    expect(decodeProcessView(above).census.censusRoot).toBe(BigInt(`0x${'ee'.repeat(32)}`));
    expect(v.stateRoot).toBe(`0x${'04'.repeat(32)}`);
    expect(v.synced).toBe(false);
    expect(v.ignored).toBe(false);
    expect(v.localStateRoot).toBeUndefined();
    expect(v.result).toBeUndefined();
    expect([v.votersCount, v.overwrittenVotesCount, v.maxVoters]).toEqual([2, 1, 100]);
    expect([v.startTime, v.duration]).toEqual([1_700_000_000, 7200]);

    const r = decodeProcessView(wire.processView.results);
    expect(r.status).toBe('results');
    expect(r.result).toEqual([3, 0]);
    expect(r.localStateRoot).toBe(`0x${'06'.repeat(32)}`);
    expect(r.synced).toBe(true);

    expectVerdicts(wire.processView.ready, wire.processViewCases, decodeProcessView);
  });

  it('decodes node info, observers included', () => {
    const i = decodeInfo(wire.info.sequencer);
    expect(i).toEqual({
      sequencerAddress: '0x0101010101010101010101010101010101010101',
      chainId: 31337,
      processRegistry: '0x0202020202020202020202020202020202020202',
      ballotVkHash: `0x${'03'.repeat(32)}`,
      batchProgramVk: `0x${'04'.repeat(32)}`,
      resultsProgramVk: `0x${'05'.repeat(32)}`,
      observer: false,
      settledBySelf: 7,
      syncedFromOthers: 8,
      lostRaces: 3,
    });
    const o = decodeInfo(wire.info.observer);
    expect(o.sequencerAddress).toBeNull();
    expect(o.observer).toBe(true);
    expectVerdicts(wire.info.sequencer, wire.infoCases, decodeInfo);
  });

  it('decodes the election key, which must lie on the curve', () => {
    expect(decodeEncryptionKey(wire.encryptionKey)).toEqual(pk);
    expectVerdicts(wire.encryptionKey, wire.encryptionKeyCases, decodeEncryptionKey);
  });

  it('decodes vote statuses and their error text', () => {
    expect(wire.voteStatuses).toEqual(Object.values(VoteStatus));
    for (const c of wire.voteStatusCases) {
      expect(accepts(decodeVoteStatus, c.json), JSON.stringify(c.json)).toBe(c.ok);
    }
    expect(decodeVoteStatus({ status: 'error', error: 'process closed' })).toEqual({
      status: VoteStatus.Error,
      error: 'process closed',
    });
    expect(decodeVoteStatus({ status: 'settled', error: null })).toEqual({
      status: VoteStatus.Settled,
    });
  });

  it('decodes tracker proofs, and the tracker vectors verify as the sequencer verdict', () => {
    const t = decodeTrackerProof(wire.trackerProof);
    expect(t.voteId).toBe(0x8000000000004321n);
    expect(t.siblings).toHaveLength(3);
    expectVerdicts(wire.trackerProof, wire.trackerProofCases, decodeTrackerProof);

    const vectors = JSON.parse(readFixture('sequencer/tracker.json')) as {
      cases: { label: string; proof: unknown; onchainRoot: string; valid: boolean }[];
    };
    for (const c of vectors.cases) {
      let valid: boolean;
      try {
        valid = verifyTrackerProof(decodeTrackerProof(c.proof), c.onchainRoot);
      } catch {
        valid = false;
      }
      expect(valid, c.label).toBe(c.valid);
    }
  });

  it('decodes participants, ballots, transitions and blobs', () => {
    const p = decodeParticipant(wire.participant);
    expect(p.address).toBe('0x0606060606060606060606060606060606060606');
    expect(p.weight).toBe(7n);
    expect(p.censusProof.leaf).toBe(censusLeaf(p.address, 7n));
    expectVerdicts(wire.participant, wire.participantCases, decodeParticipant);

    const b = decodeBallotResponse(wire.ballot);
    expect(b.ballot).toEqual(sampleBallot());
    expectVerdicts(wire.ballot, wire.ballotCases, decodeBallotResponse);

    const t = decodeTransitions(wire.transitions);
    expect(t).toHaveLength(2);
    expect(t[1]).toEqual({
      index: 1,
      oldRoot: `0x${'02'.repeat(32)}`,
      newRoot: `0x${'03'.repeat(32)}`,
      txHash: `0x${'bb'.repeat(32)}`,
      blockNumber: 48_600_120,
      sender: '0x4444444444444444444444444444444444444444',
      voters: 5,
      overwrites: 2,
      nBlobs: 2,
    });
    expectVerdicts(wire.transitions, wire.transitionCases, decodeTransitions);

    expect(decodeBlobs(wire.blobs)).toEqual(['0x0102', '0xabcdef']);
    expectVerdicts(wire.blobs, wire.blobCases, decodeBlobs);
  });

  it('writes and reads the census file', () => {
    const file = {
      participants: [
        { key: addr(0xaa), weight: 3n },
        { key: addr(0xbb).toUpperCase().replace('0X', '0x'), weight: (1n << 128n) - 1n },
      ],
    };
    expect(asJson(encodeCensusFile(file))).toEqual(wire.censusFile);
    expect(decodeCensusFile(wire.censusFile).participants.map(p => p.weight)).toEqual([
      3n,
      (1n << 128n) - 1n,
    ]);
    expectVerdicts(wire.censusFile, wire.censusFileCases, decodeCensusFile);
    expect(() =>
      encodeCensusFile({ participants: [{ key: addr(1), weight: 1n << 128n }] })
    ).toThrow(RangeError);
  });
});

describe('ids', () => {
  it('print and parse like the sequencer client', () => {
    const pid = `0x${'01'.repeat(31)}`;
    expect(normalizeProcessId(pid)).toBe(pid);
    expect(normalizeProcessId(pid.slice(2).toUpperCase())).toBe(pid);
    expect(() => normalizeProcessId('0x01')).toThrow(TypeError);

    expect(formatVoteId(0x80000000000000ffn)).toBe('0x80000000000000ff');
    expect(parseVoteId('0x80000000000000ff')).toBe(0x80000000000000ffn);
    expect(parseVoteId('80000000000000ff')).toBe(0x80000000000000ffn);
    expect(parseVoteId('0x8000000000000000')).toBe(1n << 63n);
    for (const bad of [
      '0x800000000000000',
      '0x7fffffffffffffff',
      '0x0000000000000010',
      '0x80000000000000ff00',
    ]) {
      expect(() => parseVoteId(bad), bad).toThrow(RangeError);
    }
    expect(() => formatVoteId(0x7fffffffffffffffn)).toThrow(RangeError);
  });
});

describe('checkProcessView', () => {
  const view = decodeProcessView(wire.processView.ready);
  const onchain: OnchainProcess = {
    processId: view.id,
    status: ProcessStatus.READY,
    organizationId: view.organizationId,
    encryptionKey: view.encryptionKey,
    latestStateRoot: view.stateRoot,
    result: [],
    startTime: 1_700_000_000n,
    duration: 7200n,
    maxVoters: 100n,
    votersCount: 2n,
    overwrittenVotesCount: 1n,
    creationBlock: 1n,
    batchNumber: 1n,
    metadataUri: '',
    metadataHash: `0x${'00'.repeat(32)}`,
    ballotMode: view.ballotMode,
    census: {
      origin: CensusOrigin.OffchainStatic,
      root: `0x${'05'.repeat(32)}`,
      contractAddress: '0x0000000000000000000000000000000000000000',
      uri: view.census.censusURI,
    },
    keyMode: KeyMode.Sequencer,
    grace: 180,
    lastVoteAt: 0n,
  };

  it('accepts a view that lags the chain', () => {
    checkProcessView(view, onchain);
    checkProcessView(
      { ...view, stateRoot: `0x${'00'.repeat(32)}`, votersCount: 0, status: 'ended' },
      onchain
    );
  });

  it('names the first parameter a node lies about', () => {
    const tampered: [string, typeof view][] = [
      ['process id', { ...view, id: `0x${'03'.repeat(30)}02` }],
      ['encryption key', { ...view, encryptionKey: bjjMulBase(7n) }],
      ['ballot mode', { ...view, ballotMode: { ...view.ballotMode, maxValue: 6n } }],
      ['ballot mode', { ...view, ballotMode: { ...view.ballotMode, numFields: 3 } }],
      ['census root', { ...view, census: { ...view.census, censusRoot: 6n } }],
      ['census origin', { ...view, census: { ...view.census, censusOrigin: 4 } }],
    ];
    for (const [what, bad] of tampered) {
      expect(() => checkProcessView(bad, onchain), what).toThrow(
        `process view differs from the registry: ${what}`
      );
    }
  });
});
