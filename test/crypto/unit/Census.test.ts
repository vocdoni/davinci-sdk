import {
  BN254_FR,
  LeanIMT,
  LeanIMTProof,
  SLOT_TAG,
  censusLeaf,
  censusLeafAddress,
  censusLeafWeight,
  poseidon,
  slotFromAddress,
  slotFromCspIndex,
  verifyLeanIMTProof,
} from '../../../src/crypto';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/{leanimt,census,slot}.json (lean-imt-go, Go reference).
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

  it('matches lean-imt-go roots and compact proofs, inserted or built at once', async () => {
    const tree = await LeanIMT.create();
    expect(tree.root).toBe(0n);
    expect(() => tree.proof(0)).toThrow('out of range');
    let checked = 0;
    for (const t of v.trees) {
      tree.insert(leaves[t.size - 1]);
      expect(tree.size).toBe(t.size);
      expect(tree.root, `size ${t.size}`).toBe(BigInt(t.root));
      const bulk = await LeanIMT.create(leaves.slice(0, t.size));
      expect(bulk.root, `bulk size ${t.size}`).toBe(BigInt(t.root));
      for (const p of t.proofs ?? []) {
        const want: LeanIMTProof = {
          root: BigInt(t.root),
          leaf: BigInt(p.leaf),
          pathBits: BigInt(p.path_bits),
          siblings: p.siblings.map(BigInt),
        };
        expect(tree.proof(p.index), `size ${t.size} index ${p.index}`).toEqual(want);
        expect(bulk.proof(p.index)).toEqual(want);
        expect(await verifyLeanIMTProof(want)).toBe(true);
        checked++;
      }
      expect(() => tree.proof(t.size)).toThrow('out of range');
    }
    expect(checked).toBe(1 + 2 + 3 + 5 + 8 + 13 + 33);
  });

  it('builds the same tree at once as leaf by leaf', async () => {
    const all = Array.from({ length: 70 }, (_, i) => BigInt(i * 31 + 7));
    for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33, 70]) {
      const inserted = await LeanIMT.create();
      all.slice(0, n).forEach(l => inserted.insert(l));
      const bulk = await LeanIMT.create(all.slice(0, n));
      expect([bulk.root, bulk.depth, bulk.size]).toEqual([inserted.root, inserted.depth, n]);
      for (let i = 0; i < n; i++) {
        const p = bulk.proof(i);
        expect(p).toEqual(inserted.proof(i));
        expect(await verifyLeanIMTProof(p)).toBe(true);
      }
    }
    const grown = await LeanIMT.create(all.slice(0, 13));
    grown.insert(all[13]);
    expect(grown.root).toBe((await LeanIMT.create(all.slice(0, 14))).root);
    expect(grown.indexOf(all[13])).toBe(13);
    expect(grown.indexOf(1n)).toBe(-1);
    expect(grown.leaves).toEqual(all.slice(0, 14));
  });

  it('verifies proofs by the guest rules', async () => {
    const tree = await LeanIMT.create(Array.from({ length: 13 }, (_, i) => BigInt(i + 100)));
    const p = tree.proof(6);
    expect(await verifyLeanIMTProof(p)).toBe(true);
    const high = 1n << BigInt(p.siblings.length);
    expect(await verifyLeanIMTProof({ ...p, pathBits: p.pathBits | high })).toBe(false);
    expect(await verifyLeanIMTProof({ ...p, leaf: p.leaf + 1n })).toBe(false);
    expect(await verifyLeanIMTProof({ ...p, root: p.root + 1n })).toBe(false);
    const sib = [...p.siblings];
    sib[0] += 1n;
    expect(await verifyLeanIMTProof({ ...p, siblings: sib })).toBe(false);
    expect(await verifyLeanIMTProof({ ...p, siblings: [...p.siblings.slice(0, -1), -1n] })).toBe(
      false
    );

    // Leaves and roots are field elements.
    const lone = await LeanIMT.create([7n]);
    expect(
      await verifyLeanIMTProof({ ...lone.proof(0), leaf: 7n + BN254_FR, root: 7n + BN254_FR })
    ).toBe(false);
    await expect(LeanIMT.create([BN254_FR])).rejects.toThrow('below p');
    expect(() => lone.insert(-1n)).toThrow('below p');

    // 61 siblings verify, 62 do not, even when the walk reaches the root.
    const walk = async (n: number) => {
      let node = 5n;
      const siblings: bigint[] = [];
      for (let i = 0; i < n; i++) {
        node = await poseidon([node, BigInt(i)]);
        siblings.push(BigInt(i));
      }
      return { root: node, leaf: 5n, pathBits: 0n, siblings };
    };
    expect(await verifyLeanIMTProof(await walk(61))).toBe(true);
    expect(await verifyLeanIMTProof(await walk(62))).toBe(false);
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
