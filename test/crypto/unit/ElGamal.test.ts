import { describe, expect, it, beforeAll } from 'vitest';
import { buildElGamal, ElGamal } from '../../../src/crypto/ElGamal';

describe('ElGamal', () => {
  let elgamal: ElGamal;

  beforeAll(async () => {
    elgamal = await buildElGamal();
  });

  describe('buildElGamal', () => {
    it('produces an instance with the expected surface', () => {
      expect(elgamal.babyjub).toBeDefined();
      expect(elgamal.F).toBeDefined();
      expect(typeof elgamal.encrypt).toBe('function');
      expect(typeof elgamal.generateKeyPair).toBe('function');
      expect(typeof elgamal.randomScalar).toBe('function');
      expect(typeof elgamal.packPoint).toBe('function');
      expect(typeof elgamal.unpackPoint).toBe('function');
    });
  });

  describe('randomScalar', () => {
    it('returns a bigint in [0, subgroup order)', () => {
      const k = elgamal.randomScalar();
      expect(typeof k).toBe('bigint');
      expect(k >= 0n).toBe(true);
      expect(k < elgamal.babyjub.order).toBe(true);
    });

    it('produces different values on repeated calls', () => {
      const samples = new Set<string>();
      for (let i = 0; i < 16; i++) {
        samples.add(elgamal.randomScalar().toString());
      }
      // 16 calls drawing from a >250-bit space should never collide.
      expect(samples.size).toBe(16);
    });
  });

  describe('generateKeyPair', () => {
    it('returns a private scalar and a curve point', () => {
      const { privKey, pubKey } = elgamal.generateKeyPair();
      expect(typeof privKey).toBe('bigint');
      expect(privKey > 0n).toBe(true);
      expect(privKey < elgamal.babyjub.order).toBe(true);

      // pubKey is a pair of field elements representing a curve point.
      expect(Array.isArray(pubKey)).toBe(true);
      expect(pubKey.length).toBe(2);
    });

    it('produces a public key that is on the BabyJubJub curve', () => {
      const { pubKey } = elgamal.generateKeyPair();
      // circomlibjs babyjub exposes inCurve; if not present, this throws
      // and the test fails loudly, which is the signal we want.
      expect(elgamal.babyjub.inCurve(pubKey)).toBe(true);
    });
  });

  describe('encrypt', () => {
    it('produces two curve points (c1, c2)', () => {
      const { pubKey } = elgamal.generateKeyPair();
      const k = elgamal.randomScalar();
      const { c1, c2 } = elgamal.encrypt(7n, pubKey, k);

      expect(elgamal.babyjub.inCurve(c1)).toBe(true);
      expect(elgamal.babyjub.inCurve(c2)).toBe(true);
    });

    it('is deterministic for fixed key and randomness', () => {
      const { pubKey } = elgamal.generateKeyPair();
      const k = 12345n;

      const first = elgamal.encrypt(42n, pubKey, k);
      const second = elgamal.encrypt(42n, pubKey, k);

      // c1 = k*G is fully determined by k; c2 depends on (m, pubKey, k).
      // Equality at the underlying field level:
      expect(elgamal.F.eq(first.c1[0], second.c1[0])).toBe(true);
      expect(elgamal.F.eq(first.c1[1], second.c1[1])).toBe(true);
      expect(elgamal.F.eq(first.c2[0], second.c2[0])).toBe(true);
      expect(elgamal.F.eq(first.c2[1], second.c2[1])).toBe(true);
    });
  });
});
