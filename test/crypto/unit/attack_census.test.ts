import { keccak256, concat, toBeHex } from 'ethers';
import {
  LeanIMT,
  censusLeaf,
  censusLeafAddress,
  censusLeafWeight,
  slotFromCspIndex,
  verifyLeanIMTProof,
  type LeanIMTProof,
} from '../../../src/crypto';
import { censusNodeHash } from '../../../src/crypto/census';

const L = (i: number) => censusLeaf(`0x${(i + 1).toString(16).padStart(40, '0')}`, BigInt(i + 1));
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TWO248 = 1n << 248n;
const TWO256 = 1n << 256n;

describe('attack: Keccak lean-IMT', () => {
  it('bulk build equals incremental insert for sizes 0..70, and every proof verifies', () => {
    for (let n = 0; n <= 70; n++) {
      const leaves = Array.from({ length: n }, (_, i) => L(i));
      const bulk = new LeanIMT(leaves);
      const inc = new LeanIMT();
      leaves.forEach(l => inc.insert(l));
      expect(inc.root).toBe(bulk.root);
      expect(inc.depth).toBe(bulk.depth);
      for (let i = 0; i < n; i++) {
        expect(verifyLeanIMTProof(bulk.proof(i))).toBe(true);
        expect(verifyLeanIMTProof(inc.proof(i))).toBe(true);
      }
    }
  });

  it('inserting after a bulk build keeps proofs valid', () => {
    const t = new LeanIMT(Array.from({ length: 5 }, (_, i) => L(i)));
    for (let i = 5; i < 20; i++) {
      t.insert(L(i));
      const fresh = new LeanIMT(Array.from({ length: i + 1 }, (_, j) => L(j)));
      expect(t.root).toBe(fresh.root);
      expect(verifyLeanIMTProof(t.proof(0))).toBe(true);
      expect(verifyLeanIMTProof(t.proof(i))).toBe(true);
    }
  });

  it('roots and siblings above the BN254 modulus are 256-bit values, not reduced', () => {
    const t = new LeanIMT([L(0), L(1), L(2)]);
    const p = t.proof(0);
    expect(verifyLeanIMTProof(p)).toBe(true);
    // A root that is the true root plus p must not verify (no reduction).
    expect(verifyLeanIMTProof({ ...p, root: p.root + P })).toBe(false);
    expect(
      verifyLeanIMTProof({ ...p, siblings: [p.siblings[0] + P, ...p.siblings.slice(1)] })
    ).toBe(false);
  });

  it('hashes be32(left) || be32(right)', () => {
    expect(censusNodeHash(1n, 2n)).toBe(
      BigInt(keccak256(concat([toBeHex(1n, 32), toBeHex(2n, 32)])))
    );
    expect(() => censusNodeHash(TWO256, 0n)).toThrow();
    expect(() => censusNodeHash(-1n, 0n)).toThrow();
  });

  const t = new LeanIMT(Array.from({ length: 9 }, (_, i) => L(i)));
  const good = t.proof(4);

  it('refuses leaf bounds', () => {
    expect(() => new LeanIMT([TWO248])).toThrow();
    expect(() => new LeanIMT([-1n])).toThrow();
    expect(() => new LeanIMT().insert(TWO248)).toThrow();
    // A one-leaf "tree" whose leaf equals the root and sits at 2^248 is not a proof.
    expect(verifyLeanIMTProof({ root: TWO248, leaf: TWO248, pathBits: 0n, siblings: [] })).toBe(
      false
    );
    expect(
      verifyLeanIMTProof({ root: TWO248 - 1n, leaf: TWO248 - 1n, pathBits: 0n, siblings: [] })
    ).toBe(true);
    expect(verifyLeanIMTProof({ ...good, leaf: -1n })).toBe(false);
  });

  it('refuses root and sibling outside 256 bits', () => {
    expect(verifyLeanIMTProof({ ...good, root: TWO256 })).toBe(false);
    expect(verifyLeanIMTProof({ ...good, root: -1n })).toBe(false);
    expect(verifyLeanIMTProof({ ...good, siblings: [TWO256, ...good.siblings.slice(1)] })).toBe(
      false
    );
    expect(verifyLeanIMTProof({ ...good, siblings: [-1n, ...good.siblings.slice(1)] })).toBe(false);
  });

  it('refuses path bits above the sibling count and negative path bits', () => {
    const n = good.siblings.length;
    expect(verifyLeanIMTProof({ ...good, pathBits: good.pathBits | (1n << BigInt(n)) })).toBe(
      false
    );
    expect(verifyLeanIMTProof({ ...good, pathBits: -1n })).toBe(false);
    expect(verifyLeanIMTProof({ ...good, pathBits: 1n << 64n })).toBe(false);
  });

  it('refuses depth above 61 and accepts exactly 61', () => {
    const mk = (n: number): LeanIMTProof => {
      const siblings = Array.from({ length: n }, (_, i) => BigInt(i + 1));
      let node = L(0);
      for (const s of siblings) node = censusNodeHash(node, s);
      return { root: node, leaf: L(0), pathBits: 0n, siblings };
    };
    expect(verifyLeanIMTProof(mk(61))).toBe(true);
    expect(verifyLeanIMTProof(mk(62))).toBe(false);
    expect(verifyLeanIMTProof(mk(0))).toBe(true);
  });

  it('a flipped path bit, a swapped sibling, a wrong leaf all fail', () => {
    expect(verifyLeanIMTProof({ ...good, pathBits: good.pathBits ^ 1n })).toBe(false);
    expect(verifyLeanIMTProof({ ...good, leaf: good.leaf + 1n })).toBe(false);
    const s = [...good.siblings];
    s[0] = s[0] ^ 1n;
    expect(verifyLeanIMTProof({ ...good, siblings: s })).toBe(false);
  });

  it('a non-bigint proof from a careless caller fails closed or throws a TypeError, never accepts', () => {
    const bad = { ...good, pathBits: 0 as unknown as bigint };
    let accepted = false;
    try {
      accepted = verifyLeanIMTProof(bad);
    } catch {
      accepted = false;
    }
    expect(accepted).toBe(false);
  });
});

describe('attack: census leaf and slots', () => {
  it('weight bounds 0, 1, 2^88-1 ok, 2^88 and negative refused', () => {
    const a = '0xffffffffffffffffffffffffffffffffffffffff';
    for (const w of [0n, 1n, (1n << 88n) - 1n]) {
      const leaf = censusLeaf(a, w);
      expect(leaf < TWO248).toBe(true);
      expect(censusLeafWeight(leaf)).toBe(w);
      expect(censusLeafAddress(leaf)).toBe(a);
    }
    expect(() => censusLeaf(a, 1n << 88n)).toThrow();
    expect(() => censusLeaf(a, -1n)).toThrow();
    expect(() => censusLeaf('0x12', 1n)).toThrow();
  });

  it('CSP index bounds', () => {
    expect(slotFromCspIndex(0n)).toBe(0x10n);
    expect(slotFromCspIndex((1n << 63n) - 0x11n)).toBe((1n << 63n) - 1n);
    expect(() => slotFromCspIndex((1n << 63n) - 0x10n)).toThrow();
    expect(() => slotFromCspIndex(-1n)).toThrow();
    expect(() => slotFromCspIndex(1n << 64n)).toThrow();
  });
});
