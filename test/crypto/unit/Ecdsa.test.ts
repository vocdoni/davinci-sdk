import { Wallet, concat, getAddress, keccak256, toUtf8Bytes, type Signer } from 'ethers';
import {
  type Ballot,
  CspAttestation,
  IDENTITY_CIPHERTEXT,
  ballotLeafHash,
  bjjNeg,
  cspAttestationHash,
  cspAttestationMessage,
  decodeEcdsaSignature,
  encodeEcdsaSignature,
  recoverCspSigner,
  recoverVoteSigner,
  signCspAttestation,
  signVote,
  slotFromCspIndex,
  voteEnvelopeDigest,
} from '../../../src/crypto';
import { bigIntToBytes, bigIntToHex } from '../../../src/crypto/field';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/census.json (go-ethereum crypto) and ballots.json.
type Int = string | number;
interface CspVectors {
  csp_key: string;
  csp_address: string;
  csp: {
    process_id: string;
    address: string;
    weight: string;
    index: Int;
    hash: string;
    r: string;
    s: string;
    recid: number;
    slot: Int;
  }[];
}

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const flipS = (s: string) => bigIntToHex(SECP_N - BigInt(s));

describe('CSP attestations', () => {
  const v = loadFixture<CspVectors>('zkvm/census.json');
  const csp = new Wallet(`0x${v.csp_key}`);

  it('sign and recover like go-ethereum', async () => {
    expect(csp.address).toBe(getAddress(`0x${v.csp_address}`));
    expect(v.csp.length).toBeGreaterThan(0);
    for (const c of v.csp) {
      const processId = bigIntToHex(BigInt(c.process_id), 31);
      const address = `0x${c.address}`;
      const weight = BigInt(c.weight);
      const index = BigInt(c.index);
      expect(cspAttestationHash(processId, address, weight, index)).toBe(`0x${c.hash}`);
      const a = await signCspAttestation(csp, { processId, address, weight, index });
      expect([a.r, a.s, a.recid]).toEqual([`0x${c.r}`, `0x${c.s}`, c.recid]);
      expect(recoverCspSigner(processId, a)).toBe(csp.address);
      expect(slotFromCspIndex(a.index)).toBe(BigInt(c.slot));
      // Any signed field changes the recovered key.
      expect(recoverCspSigner(processId, { ...a, index: index + 1n })).not.toBe(csp.address);
      expect(recoverCspSigner(processId, { ...a, weight: weight + 1n })).not.toBe(csp.address);
      expect(() =>
        recoverCspSigner(processId, { ...a, recid: 2 } as unknown as CspAttestation)
      ).toThrow('recovery id');
      const twin = { ...a, s: flipS(a.s), recid: (a.recid ^ 1) as 0 | 1 };
      expect(() => recoverCspSigner(processId, twin)).toThrow('high-S');
    }
  });

  it('lay the 92-byte payload out as the guest reads it', () => {
    const pid = `0x${'ab'.repeat(31)}`;
    const addr = `0x${'11'.repeat(20)}`;
    const m = cspAttestationMessage(pid, addr, 0x0102n, 0x0304n);
    expect(m).toHaveLength(92);
    expect(m[0]).toBe(0);
    expect(m.slice(1, 32).every(b => b === 0xab)).toBe(true);
    expect(m.slice(32, 52).every(b => b === 0x11)).toBe(true);
    expect(m.slice(52, 82).every(b => b === 0)).toBe(true);
    expect([m[82], m[83]]).toEqual([1, 2]);
    expect(m.slice(84, 90).every(b => b === 0)).toBe(true);
    expect([m[90], m[91]]).toEqual([3, 4]);
    expect(() => cspAttestationMessage(pid, addr, 1n << 128n, 0n)).toThrow('u128');
    expect(() => cspAttestationMessage(pid, addr, 0n, 1n << 64n)).toThrow('u64');
  });

  it('refuse to sign weights or indexes no ballot can use', async () => {
    const p = { processId: `0x${'ab'.repeat(31)}`, address: `0x${'11'.repeat(20)}` };
    await expect(signCspAttestation(csp, { ...p, weight: 1n << 88n, index: 0n })).rejects.toThrow(
      '88 bits'
    );
    await expect(
      signCspAttestation(csp, { ...p, weight: 1n, index: 0x7ffffffffffffff0n })
    ).rejects.toThrow('namespace');
  });
});

// hashes.json `vote_envelope`: davinci-zkvm go-sdk `cmd/sdk-vectors`, which rust-sdk, the
// guest's tests and the sequencer read too.
interface EnvelopeVector {
  pid: string;
  vote_id: Int;
  ballot: string[];
  signer_key: string;
  digest: string;
  signature: string;
  address: string;
}
const hx = (s: string) => (s.startsWith('0x') ? s : `0x${s}`).toLowerCase();
const ballotOf = (c: string[]): Ballot =>
  Array.from({ length: 16 }, (_, i) => ({
    c1: { x: BigInt(c[4 * i]), y: BigInt(c[4 * i + 1]) },
    c2: { x: BigInt(c[4 * i + 2]), y: BigInt(c[4 * i + 3]) },
  }));

describe('vote envelope vectors', () => {
  const vectors = loadFixture<{ vote_envelope: EnvelopeVector[] }>(
    'zkvm/hashes.json'
  ).vote_envelope;

  it('digest, sign and recover like the Go and Rust SDKs', async () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const c of vectors) {
      const pid = bigIntToHex(BigInt(hx(c.pid)), 31);
      const vid = BigInt(c.vote_id);
      const ballot = ballotOf(c.ballot);
      const signer = new Wallet(hx(c.signer_key));
      expect(signer.address).toBe(getAddress(hx(c.address)));
      expect(voteEnvelopeDigest(pid, vid, ballot)).toBe(hx(c.digest));
      expect(await signVote(signer, pid, vid, ballot)).toEqual(
        decodeEcdsaSignature(hx(c.signature))
      );
      expect(recoverVoteSigner(pid, vid, ballot, hx(c.signature))).toBe(signer.address);
    }
  });
});

describe('vote envelope signatures', () => {
  // ballots.json: davinci-zkvm ballots with their process and vote ids (1, 2, 6, 8, 16 fields).
  const ballots =
    loadFixture<{ process_id: string; vote_id: Int; ballot: string[] }[]>('zkvm/ballots.json');
  const voter = new Wallet(`0x${'42'.repeat(32)}`);
  const fromCoords = (c: string[]): Ballot =>
    Array.from({ length: 16 }, (_, i) => ({
      c1: { x: BigInt(c[4 * i]), y: BigInt(c[4 * i + 1]) },
      c2: { x: BigInt(c[4 * i + 2]), y: BigInt(c[4 * i + 3]) },
    }));
  const vote = (i: number) => ({
    pid: bigIntToHex(BigInt(ballots[i].process_id), 31),
    vid: BigInt(ballots[i].vote_id),
    ballot: fromCoords(ballots[i].ballot),
  });

  it('digest the 87-byte envelope: tag, process id as 32 bytes, vote id, ballot leaf hash', () => {
    for (let i = 0; i < ballots.length; i++) {
      const { pid, vid, ballot } = vote(i);
      const envelope = concat([
        toUtf8Bytes('davinci-vote-v1'),
        bigIntToBytes(BigInt(pid), 32),
        bigIntToBytes(vid, 8),
        ballotLeafHash(ballot),
      ]);
      expect((envelope.length - 2) / 2).toBe(87);
      expect(voteEnvelopeDigest(pid, vid, ballot)).toBe(keccak256(envelope));
    }
    // Computed apart from this code: rust-sdk ballot_leaf_hash and fr_to_be, sha3 Keccak256.
    const { pid, vid, ballot } = vote(0);
    expect(voteEnvelopeDigest(pid, vid, ballot)).toBe(
      '0x59e2ec4e1ba533e6e62485e2ecf8448c41e161cbaeea9374900fc07b1625c017'
    );
    const identity = Array.from({ length: 16 }, () => ({ ...IDENTITY_CIPHERTEXT }));
    expect(voteEnvelopeDigest(`0x${'ff'.repeat(31)}`, (1n << 64n) - 1n, identity)).toBe(
      '0x7967b7bc5d9bf9e3dce42837675781693fe33d01dc53ff2425d8cadfcd674fcd'
    );
  });

  it('sign and recover; the signer recovers only for the same process, vote id and ciphertexts', async () => {
    const { pid, vid, ballot } = vote(2);
    const sig = await signVote(voter, pid, vid, ballot);
    // RFC 6979, as k256 signs the same digest.
    const wire = encodeEcdsaSignature(sig);
    expect(wire).toBe(
      '0xcbdcb7425cc147e7313e8a1768c0e6c01fb88327f8f0b604c4258191faeda7db38f84b73a3f6510081c7150662d49ed097c0d4ac8136b23058727b7f53a3863401'
    );
    expect(recoverVoteSigner(pid, vid, ballot, sig)).toBe(voter.address);
    expect(recoverVoteSigner(pid, vid, ballot, wire)).toBe(voter.address);
    expect(
      recoverVoteSigner(pid, vid, ballot, `${wire.slice(0, -2)}${(27 + sig.v).toString(16)}`)
    ).toBe(voter.address);
    // The same vote id in another process, another vote id, or other ciphertexts.
    expect(recoverVoteSigner(bigIntToHex(BigInt(pid) ^ 1n, 31), vid, ballot, sig)).not.toBe(
      voter.address
    );
    expect(recoverVoteSigner(pid, vid ^ 1n, ballot, sig)).not.toBe(voter.address);
    const swapped = [ballot[1], ballot[0], ...ballot.slice(2)];
    expect(recoverVoteSigner(pid, vid, swapped, sig)).not.toBe(voter.address);
    const negated = [{ c1: ballot[5].c1, c2: bjjNeg(ballot[5].c2) }];
    const changed = [...ballot.slice(0, 5), ...negated, ...ballot.slice(6)];
    expect(recoverVoteSigner(pid, vid, changed, sig)).not.toBe(voter.address);
    // SDK 5's message, the bare vote id, recovers another signer.
    const old = decodeEcdsaSignature(await voter.signMessage(bigIntToBytes(vid, 32)));
    expect(recoverVoteSigner(pid, vid, ballot, old)).not.toBe(voter.address);
    // Malleated and out-of-range forms are refused.
    const twin = { r: sig.r, s: flipS(sig.s), v: (sig.v ^ 1) as 0 | 1 };
    expect(() => recoverVoteSigner(pid, vid, ballot, twin)).toThrow('high-S');
    for (const bad of [2, 26, 29, 255]) {
      const hex = `${wire.slice(0, -2)}${bad.toString(16).padStart(2, '0')}`;
      expect(() => recoverVoteSigner(pid, vid, ballot, hex), `v = ${bad}`).toThrow('recovery id');
    }
    expect(() => recoverVoteSigner(pid, vid, ballot, { ...sig, r: bigIntToHex(0n) })).toThrow(
      'r out'
    );
  });

  it('normalize a high-S signer and refuse another key, vote ids and process ids out of range', async () => {
    const { pid, vid, ballot } = vote(4);
    const honest = await signVote(voter, pid, vid, ballot);
    const twinHex = `${honest.r}${flipS(honest.s).slice(2)}${(28 - honest.v).toString(16)}`;
    const malleable = {
      signMessage: () => Promise.resolve(twinHex),
      getAddress: () => Promise.resolve(voter.address),
    } as unknown as Signer;
    expect(await signVote(malleable, pid, vid, ballot)).toEqual(honest);
    const other = Wallet.createRandom();
    const impostor = {
      signMessage: (m: Uint8Array) => other.signMessage(m),
      getAddress: () => Promise.resolve(voter.address),
    } as unknown as Signer;
    await expect(signVote(impostor, pid, vid, ballot)).rejects.toThrow('does not recover');
    await expect(signVote(voter, pid, (1n << 63n) - 1n, ballot)).rejects.toThrow('2^63');
    expect(() => voteEnvelopeDigest(pid, 1n << 64n, ballot)).toThrow('u64');
    expect(() => voteEnvelopeDigest(`0x${'ab'.repeat(32)}`, vid, ballot)).toThrow('31 bytes');
    expect(() => voteEnvelopeDigest(pid, vid, ballot.slice(1))).toThrow('16 ciphertexts');
  });
});
