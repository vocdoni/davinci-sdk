import { AbiCoder, keccak256 } from 'ethers';
import {
  BN254_FR,
  LeanIMT,
  LeanIMTProof,
  SLOT_TAG,
  censusLeaf,
  censusLeafAddress,
  censusLeafWeight,
  slotFromAddress,
  slotFromCspIndex,
  verifyLeanIMTProof,
} from '../../../src/crypto';
import { censusNodeHash } from '../../../src/crypto/census';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/{leanimt,census,slot}.json (Go reference: lean-imt-go
// shape with a Keccak hasher over 32-byte big-endian values; values are 0x hex).
type Int = string | number;
interface LeanImtVectors {
  leaves: string[];
  trees: {
    size: number;
    root: string;
    proofs?: { index: number; leaf: string; path_bits: Int; siblings: string[] }[];
  }[];
}
interface CensusVectors {
  leaves: { address: string; weight: string; leaf: string }[];
}
interface SlotVectors {
  tag: string;
  slots: { address: string; slot: Int }[];
}

describe('lean-IMT', () => {
  const v = loadFixture<LeanImtVectors>('zkvm/leanimt.json');
  const leaves = v.leaves.map(BigInt);

  it("hashes a node as Solidity's keccak256(abi.encode(left, right))", () => {
    const [l, r] = [leaves[0], (1n << 256n) - 1n];
    const solidity = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [l, r]));
    expect(censusNodeHash(l, r)).toBe(BigInt(solidity));
    expect(censusNodeHash(l, r)).not.toBe(censusNodeHash(r, l));
    expect(() => censusNodeHash(1n << 256n, 0n)).toThrow();
  });

  it('matches the Go roots and compact proofs, inserted or built at once', () => {
    const tree = new LeanIMT();
    expect(tree.root).toBe(0n);
    expect(() => tree.proof(0)).toThrow('out of range');
    let checked = 0;
    let above = 0;
    for (const t of v.trees) {
      while (tree.size < t.size) tree.insert(leaves[tree.size]);
      const root = BigInt(t.root);
      expect(tree.root, `size ${t.size}`).toBe(root);
      if (t.size === 1) expect(root, 'a single-member root is the leaf').toBe(leaves[0]);
      if (root >= BN254_FR) above++;
      const bulk = new LeanIMT(leaves.slice(0, t.size));
      expect(bulk.root, `bulk size ${t.size}`).toBe(root);
      for (const p of t.proofs ?? []) {
        const want: LeanIMTProof = {
          root,
          leaf: BigInt(p.leaf),
          pathBits: BigInt(p.path_bits),
          siblings: p.siblings.map(BigInt),
        };
        expect(tree.proof(p.index), `size ${t.size} index ${p.index}`).toEqual(want);
        expect(bulk.proof(p.index)).toEqual(want);
        expect(verifyLeanIMTProof(want)).toBe(true);
        checked++;
      }
      expect(() => tree.proof(t.size)).toThrow('out of range');
    }
    expect(checked).toBe(1 + 2 + 3 + 5 + 8 + 13 + 33 + 5);
    // Most roots are above the BN254 modulus and are kept as they are.
    expect(v.trees.filter(t => t.size > 1)).toHaveLength(43);
    expect(above).toBe(36);
  });

  it('builds the same tree at once as leaf by leaf', () => {
    const all = Array.from({ length: 70 }, (_, i) => BigInt(i * 31 + 7));
    for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33, 70]) {
      const inserted = new LeanIMT();
      all.slice(0, n).forEach(l => inserted.insert(l));
      const bulk = new LeanIMT(all.slice(0, n));
      expect([bulk.root, bulk.depth, bulk.size]).toEqual([inserted.root, inserted.depth, n]);
      for (let i = 0; i < n; i++) {
        const p = bulk.proof(i);
        expect(p).toEqual(inserted.proof(i));
        expect(verifyLeanIMTProof(p)).toBe(true);
      }
    }
    const grown = new LeanIMT(all.slice(0, 13));
    grown.insert(all[13]);
    expect(grown.root).toBe(new LeanIMT(all.slice(0, 14)).root);
    expect(grown.indexOf(all[13])).toBe(13);
    expect(grown.indexOf(1n)).toBe(-1);
    expect(grown.leaves).toEqual(all.slice(0, 14));
  });

  it('verifies proofs by the guest rules', () => {
    const tree = new LeanIMT(Array.from({ length: 13 }, (_, i) => BigInt(i + 100)));
    const p = tree.proof(6);
    expect(verifyLeanIMTProof(p)).toBe(true);
    const high = 1n << BigInt(p.siblings.length);
    expect(verifyLeanIMTProof({ ...p, pathBits: p.pathBits | high })).toBe(false);
    expect(verifyLeanIMTProof({ ...p, leaf: p.leaf + 1n })).toBe(false);
    expect(verifyLeanIMTProof({ ...p, root: p.root ^ (1n << 255n) })).toBe(false);
    const sib = [...p.siblings];
    sib[0] += 1n;
    expect(verifyLeanIMTProof({ ...p, siblings: sib })).toBe(false);
    expect(verifyLeanIMTProof({ ...p, siblings: [...p.siblings.slice(0, -1), -1n] })).toBe(false);
    expect(verifyLeanIMTProof({ ...p, root: 1n << 256n })).toBe(false);

    // An internal node presented as a leaf at a shorter path reaches the
    // root, but it is not below 2^248 (guest check 3A.6).
    const node = 0xffn << 248n;
    const other = 100n;
    expect(
      verifyLeanIMTProof({
        root: censusNodeHash(node, other),
        leaf: node,
        pathBits: 0n,
        siblings: [other],
      })
    ).toBe(false);
    const below = node >> 8n;
    expect(
      verifyLeanIMTProof({
        root: censusNodeHash(below, other),
        leaf: below,
        pathBits: 0n,
        siblings: [other],
      })
    ).toBe(true);
    expect(() => new LeanIMT([1n << 248n])).toThrow('2^248');
    expect(() => tree.insert(-1n)).toThrow('2^248');

    // Roots and siblings are 256-bit values, not field elements.
    const big = (1n << 256n) - 1n;
    expect(
      verifyLeanIMTProof({ root: censusNodeHash(7n, big), leaf: 7n, pathBits: 0n, siblings: [big] })
    ).toBe(true);

    // 61 siblings verify, 62 do not, even when the walk reaches the root.
    const walk = (n: number) => {
      let at = 5n;
      const siblings: bigint[] = [];
      for (let i = 0; i < n; i++) {
        at = censusNodeHash(at, BigInt(i));
        siblings.push(BigInt(i));
      }
      return { root: at, leaf: 5n, pathBits: 0n, siblings };
    };
    expect(verifyLeanIMTProof(walk(61))).toBe(true);
    expect(verifyLeanIMTProof(walk(62))).toBe(false);
  });
});

describe('census leaves and slots', () => {
  it('builds leaves like the Go reference and splits them back', () => {
    const v = loadFixture<CensusVectors>('zkvm/census.json');
    for (const l of v.leaves) {
      const leaf = censusLeaf(`0x${l.address}`, BigInt(l.weight));
      expect(leaf).toBe(BigInt(l.leaf));
      expect(censusLeafWeight(leaf)).toBe(BigInt(l.weight));
      expect(censusLeafAddress(leaf)).toBe(`0x${l.address}`);
      // Bits above 247 are not part of the address the guest binds.
      expect(censusLeafAddress(leaf + (1n << 248n))).toBe(`0x${l.address}`);
    }
    expect(() => censusLeaf(`0x${'ff'.repeat(20)}`, 1n << 88n)).toThrow('88 bits');
    expect(() => censusLeaf(`0x${'00'.repeat(20)}`, -1n)).toThrow('88 bits');
    expect(() => censusLeaf('0x1234', 1n)).toThrow('20 bytes');
  });

  it('derives Merkle slots from the address like the Go reference', () => {
    const v = loadFixture<SlotVectors>('zkvm/slot.json');
    expect(v.tag).toBe(SLOT_TAG);
    expect(v.slots).toHaveLength(20);
    for (const c of v.slots) {
      const slot = slotFromAddress(`0x${c.address}`);
      expect(slot, c.address).toBe(BigInt(c.slot));
      expect(slot >= 0x10n && slot <= 0x7fffffffffffffffn).toBe(true);
    }
    // Case and checksum do not matter.
    const a = v.slots[2].address;
    expect(slotFromAddress(`0x${a.toUpperCase()}`)).toBe(BigInt(v.slots[2].slot));
  });

  it('derives CSP slots from the index within the ballot namespace', () => {
    expect(slotFromCspIndex(0n)).toBe(0x10n);
    expect(slotFromCspIndex(0x7fffffffffffffefn)).toBe(0x7fffffffffffffffn);
    expect(() => slotFromCspIndex(0x7ffffffffffffff0n)).toThrow('namespace');
    expect(() => slotFromCspIndex((1n << 64n) - 1n)).toThrow('namespace');
    expect(() => slotFromCspIndex(-1n)).toThrow('namespace');
  });
});
