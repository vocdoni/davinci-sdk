import {
  BJJ_B8,
  BJJ_IDENTITY,
  BJJ_SUBGROUP_ORDER,
  BN254_FR,
  BjjPoint,
  IDENTITY_CIPHERTEXT,
  bjjAdd,
  bjjInSubgroup,
  bjjIsOnCurve,
  bjjMul,
  bjjMulBase,
  bjjNeg,
  elgamalEncrypt,
  isIdentityCiphertext,
  isValidEncryptionKey,
  pointFromReducedTE,
  pointToReducedTE,
  randomBallotSecret,
  toBjjPoint,
} from '../../../src/crypto';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/{babyjubjub,elgamal}.json (go-iden3-crypto).
interface Dec {
  x: string;
  y: string;
}
interface BjjVectors {
  b8: Dec;
  sub_order: string;
  muls: { k: string; p: Dec; rte: Dec }[];
  adds: { a: Dec; b: Dec; sum: Dec }[];
}
interface ElGamalVectors {
  sk: string;
  pk: Dec;
  encryptions: { m: string; k: string; ct: { c1: Dec; c2: Dec } }[];
}

const pt = (d: Dec): BjjPoint => ({ x: BigInt(d.x), y: BigInt(d.y) });

describe('BabyJubJub', () => {
  const v = loadFixture<BjjVectors>('zkvm/babyjubjub.json');

  it('has the iden3 generator and subgroup order', () => {
    expect(BJJ_B8).toEqual(pt(v.b8));
    expect(BJJ_SUBGROUP_ORDER).toBe(BigInt(v.sub_order));
  });

  it('multiplies like go-iden3-crypto, and maps to and from reduced TE', () => {
    for (const m of v.muls) {
      const p = pt(m.p);
      expect(bjjMulBase(BigInt(m.k)), `k = ${m.k}`).toEqual(p);
      expect(bjjIsOnCurve(p)).toBe(true);
      expect(bjjInSubgroup(p)).toBe(true);
      expect(pointToReducedTE(p)).toEqual(pt(m.rte));
      expect(pointFromReducedTE(BigInt(m.rte.x), BigInt(m.rte.y))).toEqual(p);
    }
  });

  it('adds like go-iden3-crypto', () => {
    expect(v.adds.length).toBeGreaterThan(0);
    for (const a of v.adds) {
      expect(bjjAdd(pt(a.a), pt(a.b))).toEqual(pt(a.sum));
      expect(bjjAdd(pt(a.sum), bjjNeg(pt(a.b)))).toEqual(pt(a.a));
    }
  });

  it('follows the group laws', () => {
    expect(bjjAdd(BJJ_B8, BJJ_IDENTITY)).toEqual(BJJ_B8);
    expect(bjjAdd(BJJ_B8, bjjNeg(BJJ_B8))).toEqual(BJJ_IDENTITY);
    expect(bjjMul(BJJ_B8, BJJ_SUBGROUP_ORDER)).toEqual(BJJ_IDENTITY);
    expect(bjjMul(BJJ_B8, 0n)).toEqual(BJJ_IDENTITY);
    expect(bjjMul(BJJ_B8, BJJ_SUBGROUP_ORDER + 5n)).toEqual(bjjMulBase(5n));
  });

  it('tells subgroup points from the other curve points', () => {
    const order2 = { x: 0n, y: BN254_FR - 1n };
    expect(bjjIsOnCurve(order2)).toBe(true);
    expect(bjjInSubgroup(order2)).toBe(false);
    // Adding the order-2 point to a subgroup point leaves the subgroup.
    const outside = bjjAdd(bjjMulBase(12345n), order2);
    expect(bjjIsOnCurve(outside)).toBe(true);
    expect(bjjInSubgroup(outside)).toBe(false);
    expect(bjjInSubgroup(bjjMul(outside, 2n))).toBe(true);
    expect(bjjInSubgroup({ x: 1n, y: 1n })).toBe(false);
  });

  it('accepts only on-curve, non-identity subgroup points as election keys', () => {
    expect(isValidEncryptionKey(bjjMulBase(12345n))).toBe(true);
    expect(isValidEncryptionKey(BJJ_IDENTITY)).toBe(false);
    expect(isValidEncryptionKey({ x: 0n, y: BN254_FR - 1n })).toBe(false);
    expect(isValidEncryptionKey({ x: 1n, y: 2n })).toBe(false);
    const k = bjjMulBase(99n);
    expect(isValidEncryptionKey({ x: k.x + BN254_FR, y: k.y })).toBe(false);
  });

  it('refuses points off the curve or with non-canonical coordinates', () => {
    expect(() => toBjjPoint(1n, 1n)).toThrow('not a BabyJubJub point');
    expect(() => toBjjPoint(BJJ_B8.x + BN254_FR, BJJ_B8.y)).toThrow('below p');
    expect(() => bjjAdd({ x: 1n, y: 1n }, BJJ_B8)).toThrow();
    expect(() => bjjMul(BJJ_B8, -1n)).toThrow('non-negative');
    expect(() => pointFromReducedTE(BN254_FR, 0n)).toThrow('below p');
    expect(() => pointFromReducedTE(1n, 1n)).toThrow('not on the TE curve');
  });
});

describe('ElGamal', () => {
  const v = loadFixture<ElGamalVectors>('zkvm/elgamal.json');

  it('encrypts like the Go reference', () => {
    const pk = pt(v.pk);
    expect(bjjMulBase(BigInt(v.sk))).toEqual(pk);
    for (const e of v.encryptions) {
      expect(elgamalEncrypt(pk, BigInt(e.m), BigInt(e.k)), `m = ${e.m}`).toEqual({
        c1: pt(e.ct.c1),
        c2: pt(e.ct.c2),
      });
    }
  });

  it('knows the identity ciphertext', () => {
    expect(isIdentityCiphertext(IDENTITY_CIPHERTEXT)).toBe(true);
    expect(isIdentityCiphertext(elgamalEncrypt(pt(v.pk), 0n, 1n))).toBe(false);
    // Enc(0; 0) is the identity: why padding must be checked by value, not by plaintext.
    expect(isIdentityCiphertext(elgamalEncrypt(pt(v.pk), 0n, 0n))).toBe(true);
  });

  it('draws ballot secrets below p', () => {
    const seen = new Set<bigint>();
    for (let i = 0; i < 20; i++) {
      const k = randomBallotSecret();
      expect(k >= 0n && k < BN254_FR).toBe(true);
      seen.add(k);
    }
    expect(seen.size).toBe(20);
  });
});
