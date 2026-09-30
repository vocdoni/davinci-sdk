import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256, toUtf8Bytes, toUtf8String } from 'ethers';
import { CensusError, CensusOrigin, OffchainCensus } from '../../../src/census';
import { verifyLeanIMTProof } from '../../../src/crypto';
import { readFixture } from '../../helpers/fixtures';

interface Proof {
  root: string;
  leaf: string;
  pathBits: number;
  siblings: string[];
}

interface CensusSet {
  name: string;
  participants: { key: string; weight: string }[];
  compact: string;
  pretty: string;
  root: string;
  proofs: Proof[];
  slots: string[];
  node: { compact: boolean; pretty: boolean };
}

interface DocumentCase {
  name: string;
  body: string;
  node: { ok: boolean; root?: string; error?: string };
}

interface DemoCase {
  path: string;
  sha256: string;
  members: number;
  root: string;
  rewritten: boolean;
  node: boolean;
}

// Every large integer in this file is a string already; its bodies hold bare
// numbers that must stay as they are.
const vectors = JSON.parse(readFixture('sequencer/census-files.json')) as {
  sets: CensusSet[];
  documents: DocumentCase[];
  demo: DemoCase[];
};

const hex = (dec: string) => `0x${BigInt(dec).toString(16).padStart(64, '0')}`;
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

describe('OffchainCensus', () => {
  it('is a static Merkle census that must be published', () => {
    const census = new OffchainCensus();
    expect(census.censusOrigin).toBe(CensusOrigin.OffchainStatic);
    expect(census.requiresPublishing).toBe(true);
    expect(census.isPublished).toBe(false);
    expect(census.participants).toEqual([]);
    expect(census.size).toBe(0);
    expect(() => census.toRegistryCensus()).toThrow(CensusError);
  });

  it('adds plain addresses with weight 1 and weighted members, lowercased, in order', () => {
    const census = new OffchainCensus();
    census.add('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
    census.add([B, C]);
    census.add({ key: A, weight: 100 });
    census.add([
      { key: '0x4444444444444444444444444444444444444444', weight: '500' },
      { key: '5555555555555555555555555555555555555555', weight: 7n },
    ]);
    expect(census.participants).toEqual([
      { key: '0xabcdef1234567890abcdef1234567890abcdef12', weight: '1' },
      { key: B, weight: '1' },
      { key: C, weight: '1' },
      { key: A, weight: '100' },
      { key: '0x4444444444444444444444444444444444444444', weight: '500' },
      { key: '0x5555555555555555555555555555555555555555', weight: '7' },
    ]);
    expect(census.addresses[0]).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    expect(census.getWeight(A.toUpperCase().replace('0X', '0x'))).toBe('100');
    expect(census.getWeight('0x9999999999999999999999999999999999999999')).toBeUndefined();
    expect(census.has(C)).toBe(true);
  });

  it('changes the weight of a member in place and removes members', () => {
    const census = new OffchainCensus();
    census.add([A, B, C]);
    census.add({ key: B, weight: 9 });
    expect(census.addresses).toEqual([A, B, C]);
    expect(census.getWeight(B)).toBe('9');
    census.remove(B);
    census.remove('0x9999999999999999999999999999999999999999');
    expect(census.addresses).toEqual([A, C]);
    expect(census.slotOf(B)).toBeUndefined();
    census.add(B);
    expect(census.addresses).toEqual([A, C, B]);
  });

  it('refuses bad addresses and weights, and adds nothing from a batch with one', () => {
    const census = new OffchainCensus();
    const refused: [unknown, string][] = [
      ['0x123', 'not an Ethereum address'],
      ['0x0000000000000000000000000000000000000000', 'zero address'],
      ['0xAbCdEf1234567890aBcDeF1234567890AbCdEf12', 'bad address checksum'],
      [{ key: A, weight: -1 }, 'not a non-negative integer'],
      [{ key: A, weight: 1.5 }, 'not a non-negative integer'],
      [{ key: A, weight: 2 ** 53 }, 'not a non-negative integer'],
      [{ key: A, weight: '1.0' }, 'not a non-negative integer'],
      [{ key: A, weight: '-1' }, 'not a non-negative integer'],
      [{ key: A, weight: 1n << 88n }, 'does not fit in 88 bits'],
      [{ key: A, weight: '309485009821345068724781056' }, 'does not fit in 88 bits'],
    ];
    for (const [entry, msg] of refused) {
      expect(() => census.add(entry as string), String(entry)).toThrow(msg);
    }
    expect(() => census.add([B, '0x12'])).toThrow(CensusError);
    expect(census.size).toBe(0);
    census.add({ key: A, weight: (1n << 88n) - 1n });
    census.add({ key: B, weight: 0 });
    expect(census.getWeight(A)).toBe('309485009821345068724781055');
  });

  it('reproduces the Rust census files, roots, proofs and slots', async () => {
    for (const set of vectors.sets) {
      const census = new OffchainCensus();
      census.add(set.participants);
      expect(toUtf8String(census.serialize()), set.name).toBe(set.pretty);
      expect(census.toJSON()).toEqual({ participants: set.participants });
      expect(await census.root(), set.name).toBe(hex(set.root));
      expect(set.node).toEqual({ compact: true, pretty: true });
      for (const [i, p] of set.participants.entries()) {
        expect(census.slotOf(p.key)).toBe(BigInt(set.slots[i]));
        const proof = await census.proof(p.key);
        const want = set.proofs[i];
        expect(proof).toEqual({
          root: BigInt(want.root),
          leaf: BigInt(want.leaf),
          pathBits: BigInt(want.pathBits),
          siblings: want.siblings.map(BigInt),
        });
        expect(await verifyLeanIMTProof(proof)).toBe(true);
        expect(await census.witness(p.key)).toEqual({
          type: 'merkle',
          weight: BigInt(p.weight),
          proof,
        });
      }
    }
  });

  it('reads the Rust census files, compact and pretty, as bytes, text or JSON', async () => {
    for (const set of vectors.sets) {
      for (const form of [
        set.compact,
        set.pretty,
        toUtf8Bytes(set.compact),
        JSON.parse(set.pretty) as unknown,
      ]) {
        const census = OffchainCensus.fromJSON(form);
        expect(census).toBeInstanceOf(OffchainCensus);
        expect(census.participants).toEqual(set.participants);
        expect(await census.root()).toBe(hex(set.root));
      }
    }
  });

  it('rewrites the demo census files byte for byte', async () => {
    for (const d of vectors.demo) {
      const bytes = new Uint8Array(
        readFileSync(join(__dirname, '../../fixtures/sequencer/demo', d.path))
      );
      expect(sha256(bytes)).toBe(`0x${d.sha256}`);
      expect(d.node && d.rewritten).toBe(true);
      const census = OffchainCensus.fromJSON(bytes);
      expect(census.size).toBe(d.members);
      expect(await census.root()).toBe(hex(d.root));
      expect(census.serialize()).toEqual(bytes);
    }
  });

  it('accepts no census file the nodes refuse, and reads the same root when both accept', async () => {
    const accepted: string[] = [];
    for (const doc of vectors.documents) {
      let census: OffchainCensus;
      try {
        census = OffchainCensus.fromJSON(toUtf8Bytes(doc.body));
      } catch (err) {
        expect(err, doc.name).toBeInstanceOf(CensusError);
        continue;
      }
      accepted.push(doc.name);
      expect(doc.node.ok, doc.name).toBe(true);
      expect(await census.root(), doc.name).toBe(hex(doc.node.root as string));
    }
    // What the SDK reads; the rest the nodes read too (numbers as weights,
    // `address`, dumps, JSON lines, the zero address as an empty leaf) or refuse.
    expect(accepted).toEqual([
      'canonical',
      'uppercase hex digits',
      'no 0x prefix',
      'leading zero weight',
      'weight 2^88 - 1',
      'unknown member field',
      'unknown top-level field',
      'surrounding whitespace',
    ]);
    const refusedByBoth = vectors.documents.filter(d => !d.node.ok).map(d => d.name);
    expect(refusedByBoth).toEqual(
      expect.arrayContaining(['byte-order mark', 'participants twice', 'same address twice'])
    );
  });

  it('refuses an empty census and a non-member proof', async () => {
    const census = new OffchainCensus();
    await expect(census.root()).rejects.toThrow('the census has no members');
    expect(() => OffchainCensus.fromJSON('{"participants":[]}')).toThrow('no members');
    census.add(A);
    await expect(census.proof(B)).rejects.toThrow(`${B} is not in the census`);
  });

  it('drops the published root and the tree when the members change', async () => {
    const census = new OffchainCensus();
    census.add([A, B]);
    const root = await census.root();
    census._setPublishedData(root, 'https://files.example.org/c.json');
    expect(census.isPublished).toBe(true);
    expect(census.toRegistryCensus()).toEqual({
      origin: CensusOrigin.OffchainStatic,
      root,
      uri: 'https://files.example.org/c.json',
    });
    census.add(A); // no change
    expect(census.isPublished).toBe(true);
    census.add(C);
    expect(census.isPublished).toBe(false);
    expect(census.censusRoot).toBeNull();
    expect(census.censusURI).toBeNull();
    expect(await census.root()).not.toBe(root);
    census.remove(C);
    expect(await census.root()).toBe(root);
  });
});
