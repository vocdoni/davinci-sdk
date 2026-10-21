import {
  BJJ_IDENTITY,
  BN254_FR,
  IDENTITY_CIPHERTEXT,
  bjjMulBase,
  buildBallot,
  ballotPublicSignals,
  checkBallot,
  encryptBallot,
  packBallotMode,
  unpackBallotMode,
  type Ballot,
  type BallotModeValues,
} from '../../../src/crypto';

const PK = bjjMulBase(987654321n);
const PID = `0x${'ab'.repeat(31)}`;
const ADDR = '0x1111111111111111111111111111111111111111';
const K = 0x2f1e8d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeffn;
const mode = (nf: number, over: Partial<BallotModeValues> = {}): BallotModeValues => ({
  numFields: nf,
  groupSize: nf,
  uniqueValues: false,
  costExponent: 1,
  maxValue: 5n,
  minValue: 0n,
  maxValueSum: 0n,
  minValueSum: 0n,
  ...over,
});
const identityBallot = (): Ballot =>
  Array.from({ length: 16 }, () => ({
    c1: { ...IDENTITY_CIPHERTEXT.c1 },
    c2: { ...IDENTITY_CIPHERTEXT.c2 },
  }));

describe('attack: ballot construction for numFields 1..16', () => {
  for (let nf = 1; nf <= 16; nf++) {
    it(`nf=${nf}: padding is the identity, signals are 71 and the identity fills the tail`, async () => {
      const built = await buildBallot({
        processId: PID,
        address: ADDR,
        encryptionKey: PK,
        ballotMode: mode(nf),
        fields: Array.from({ length: nf }, (_, i) => i % 3),
        weight: 7n,
        k: K,
      });
      expect(built.publicSignals).toHaveLength(71);
      for (let f = nf; f < 16; f++) {
        expect(built.ballot[f].c1).toEqual(BJJ_IDENTITY);
        expect(built.ballot[f].c2).toEqual(BJJ_IDENTITY);
        const o = 7 + 4 * f;
        expect(built.publicSignals.slice(o, o + 4)).toEqual([0n, 1n, 0n, 1n]);
      }
      // Live fields are not the identity (the key is not trivial).
      for (let f = 0; f < nf; f++) expect(built.ballot[f].c1).not.toEqual(BJJ_IDENTITY);
    });
  }

  it('refuses numFields 0, 17 and more values than fields', async () => {
    for (const nf of [0, 17, 255, -1, 1.5]) {
      await expect(encryptBallot(PK, [], K, nf)).rejects.toThrow();
    }
    await expect(encryptBallot(PK, [1, 2], K, 1)).rejects.toThrow();
  });

  it('refuses a k outside the field, and a non-subgroup or identity key', async () => {
    await expect(encryptBallot(PK, [1], BN254_FR, 1)).rejects.toThrow();
    await expect(encryptBallot(PK, [1], -1n, 1)).rejects.toThrow();
    const base = {
      processId: PID,
      address: ADDR,
      ballotMode: mode(1),
      fields: [1],
      weight: 1n,
      k: K,
    };
    await expect(buildBallot({ ...base, encryptionKey: BJJ_IDENTITY })).rejects.toThrow();
    await expect(buildBallot({ ...base, encryptionKey: { x: 1n, y: 1n } })).rejects.toThrow();
    // weight bounds
    await expect(buildBallot({ ...base, encryptionKey: PK, weight: 1n << 88n })).rejects.toThrow();
    await expect(buildBallot({ ...base, encryptionKey: PK, weight: -1n })).rejects.toThrow();
  });
});

describe('attack: ballotPublicSignals refuses what the guest refuses', () => {
  const base = (m: BallotModeValues, ballot: Ballot = identityBallot()) => ({
    processId: 5n,
    ballotMode: m,
    encryptionKey: PK,
    address: 6n,
    voteId: (1n << 63n) + 1n,
    ballot,
    weight: 1n,
  });

  it('accepts a normal ballot', () => {
    expect(ballotPublicSignals(base(mode(3)))).toHaveLength(71);
  });

  // BUG: the guest refuses num_fields 0 or above 16 (FAIL_BINDING); ballotPublicSignals packs them.
  it('refuses numFields 0 and above 16', () => {
    for (const nf of [0, 17, 255]) {
      expect(() => ballotPublicSignals(base(mode(nf)))).toThrow();
    }
  });

  // BUG: the guest requires canonical (below p) ciphertext coordinates; the signals take any bigint.
  it('refuses non-canonical ciphertext coordinates and signals', () => {
    const b = identityBallot();
    b[0] = { c1: { x: BN254_FR, y: 1n }, c2: { ...BJJ_IDENTITY } };
    expect(() => ballotPublicSignals(base(mode(1), b))).toThrow();
    expect(() => ballotPublicSignals({ ...base(mode(3)), address: BN254_FR })).toThrow();
    expect(() => ballotPublicSignals({ ...base(mode(3)), processId: -1n })).toThrow();
    expect(() => ballotPublicSignals({ ...base(mode(3)), weight: BN254_FR + 1n })).toThrow();
    expect(() => ballotPublicSignals({ ...base(mode(3)), voteId: 5n })).toThrow();
    expect(() => ballotPublicSignals({ ...base(mode(3)), voteId: 1n << 64n })).toThrow();
  });

  it('refuses non-identity padding and wrong length', () => {
    const b = identityBallot();
    b[5] = { c1: { ...PK }, c2: { ...BJJ_IDENTITY } };
    expect(() => ballotPublicSignals(base(mode(3), b))).toThrow();
    expect(() => ballotPublicSignals(base(mode(3), b.slice(0, 15)))).toThrow();
    expect(() => ballotPublicSignals(base(mode(3), [...b, ...b]))).toThrow();
  });
});

describe('attack: ballot mode packing', () => {
  it('round-trips the bounds and refuses overflow', () => {
    const top = mode(16, {
      groupSize: 16,
      costExponent: 255,
      maxValue: (1n << 48n) - 1n,
      minValue: (1n << 48n) - 1n,
      maxValueSum: (1n << 63n) - 1n,
      minValueSum: (1n << 63n) - 1n,
      uniqueValues: true,
    });
    expect(unpackBallotMode(packBallotMode(top))).toEqual(top);
    expect(packBallotMode(top) >> 247n).toBe(0n);
    for (const over of [
      { maxValue: 1n << 48n },
      { minValue: 1n << 48n },
      { maxValueSum: 1n << 63n },
      { minValueSum: 1n << 63n },
      { minValue: -1n },
      { groupSize: 17 },
      { costExponent: 256 },
      { numFields: 256 },
      { numFields: -1 },
    ]) {
      expect(() => packBallotMode(mode(16, over))).toThrow();
    }
    expect(() => unpackBallotMode(1n << 247n)).toThrow();
    expect(() => unpackBallotMode(-1n)).toThrow();
    // groupSize 5 > numFields 3
    expect(() => unpackBallotMode(3n | (5n << 8n))).toThrow();
  });
});

describe('attack: checkBallot against the circuit', () => {
  it('the weight is the cap when maxValueSum is zero, even at the field edge', () => {
    expect(checkBallot([5, 5], mode(2), 10n).valid).toBe(true);
    expect(checkBallot([5, 5], mode(2), 9n).valid).toBe(false);
    expect(checkBallot([1], mode(1), 0n).valid).toBe(false);
    expect(checkBallot([0], mode(1), 0n).valid).toBe(true);
  });

  it('refuses values the comparators cannot hold', () => {
    const m = mode(2, { maxValue: (1n << 48n) - 1n });
    expect(checkBallot([(1n << 48n) - 1n], m, 1n << 62n).valid).toBe(true);
    expect(checkBallot([1n << 48n], m, 1n << 62n).valid).toBe(false);
    // The circuit compares the cost with the weight in 89 bits: any weight below 2^88 with
    // maxValueSum 0 takes a ballot it covers, and checkBallot says so.
    expect(checkBallot([1], m, 1n << 64n).valid).toBe(true);
    expect(checkBallot([1], m, 1n << 88n).valid).toBe(false);
    expect(checkBallot([-1], m, 10n).valid).toBe(false);
    expect(checkBallot([1, 2, 3], m, 10n).valid).toBe(false);
  });

  it('cost exponent 0 counts every active field once, zeros included', () => {
    const m = mode(3, { costExponent: 0, maxValueSum: 3n, minValueSum: 3n });
    expect(checkBallot([0, 0, 0], m, 1n).valid).toBe(true);
    expect(checkBallot([0, 0], m, 1n).valid).toBe(true);
    const m2 = mode(3, { costExponent: 0, maxValueSum: 2n });
    expect(checkBallot([0, 0, 0], m2, 1n).valid).toBe(false);
  });

  it('unique values apply to the active fields only, padding zeros do not collide', () => {
    const m = mode(2, { uniqueValues: true });
    expect(checkBallot([1, 2], m, 10n).valid).toBe(true);
    expect(checkBallot([1, 1], m, 10n).valid).toBe(false);
    // A missing value is a zero in an active field.
    expect(checkBallot([0], m, 10n).valid).toBe(false);
    expect(checkBallot([0, 0], m, 10n).valid).toBe(false);
    expect(checkBallot([0, 1], m, 10n).valid).toBe(true);
    expect(checkBallot([0], mode(5, { uniqueValues: true }), 10n).valid).toBe(false);
  });

  it('a mode that does not pack or numFields above 16 fails', () => {
    expect(checkBallot([], mode(17), 1n).valid).toBe(false);
    expect(checkBallot([], mode(2, { groupSize: 3 }), 1n).valid).toBe(false);
  });

  it('weight at or above p is refused', () => {
    expect(checkBallot([1], mode(1), BN254_FR).valid).toBe(false);
  });
});
