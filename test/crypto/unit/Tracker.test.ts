import { concat, getBytes, hexlify, sha256 } from 'ethers';
import { TrackerProof, verifyTrackerProof, voteIdLeafHash } from '../../../src/crypto';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: test/fixtures/sequencer/tracker.json, arbo proofs from davinci-sequencer cb2d39c with
// the verdict of its `verify_tracker` (generator in test/fixtures/sequencer/tracker-gen).
interface TrackerWire {
  processId: string;
  voteId: string;
  root: string;
  siblings: string[];
}
interface TrackerVectors {
  cases: { label: string; proof: TrackerWire; onchainRoot: string; valid: boolean }[];
}

const decode = (w: TrackerWire): TrackerProof => ({ ...w, voteId: BigInt(w.voteId) });
const bigIntHex = (x: bigint) => `0x${x.toString(16).padStart(64, '0')}`;

describe('tracker proofs', () => {
  const v = loadFixture<TrackerVectors>('sequencer/tracker.json');

  it('verify exactly like the sequencer client', () => {
    expect(v.cases.filter(c => c.valid).length).toBe(25);
    expect(v.cases.filter(c => !c.valid).length).toBe(26);
    for (const c of v.cases) {
      expect(verifyTrackerProof(decode(c.proof), c.onchainRoot), c.label).toBe(c.valid);
    }
  });

  it('hash the vote id leaf as sha256(vid_le8 || 0^32 || 0x01)', () => {
    const lone = v.cases[0];
    expect(lone.proof.siblings).toHaveLength(0);
    // A lone leaf is the root.
    expect(hexlify(voteIdLeafHash(BigInt(lone.proof.voteId)))).toBe(lone.proof.root);
    const le8 = new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0x80]);
    expect(hexlify(voteIdLeafHash(0x8000000000000102n))).toBe(
      sha256(concat([le8, new Uint8Array(32), new Uint8Array([1])]))
    );
  });

  it('refuse more than 64 levels even when the walk reaches the root', () => {
    const vid = 0x8000000000000005n;
    const walk = (levels: number) => {
      const siblings = Array.from({ length: levels }, (_, i) => bigIntHex(BigInt(i + 1)));
      let node = voteIdLeafHash(vid);
      for (let i = levels - 1; i >= 0; i--) {
        const s = getBytes(siblings[i]);
        node = getBytes(sha256(concat((vid >> BigInt(i)) & 1n ? [s, node] : [node, s])));
      }
      const root = hexlify(node);
      return { processId: `0x${'00'.repeat(31)}`, voteId: vid, root, siblings };
    };
    const ok = walk(64);
    expect(verifyTrackerProof(ok, ok.root)).toBe(true);
    const deep = walk(65);
    expect(verifyTrackerProof(deep, deep.root)).toBe(false);
  });

  it('refuse malformed roots and siblings instead of throwing', () => {
    const c = v.cases.find(x => x.valid && x.proof.siblings.length > 0);
    if (!c) throw new Error('no honest proof with siblings');
    const p = decode(c.proof);
    expect(verifyTrackerProof(p, '0x1234')).toBe(false);
    expect(
      verifyTrackerProof({ ...p, siblings: [...p.siblings.slice(1), '0x00'] }, c.onchainRoot)
    ).toBe(false);
    expect(verifyTrackerProof({ ...p, voteId: p.voteId + (1n << 64n) }, c.onchainRoot)).toBe(false);
  });
});
