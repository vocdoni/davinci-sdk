import { Wallet, getAddress, type Signer } from 'ethers';
import {
  CspAttestation,
  cspAttestationHash,
  cspAttestationMessage,
  decodeEcdsaSignature,
  encodeEcdsaSignature,
  recoverCspSigner,
  recoverVoteIdSigner,
  signCspAttestation,
  signVoteId,
  slotFromCspIndex,
  voteIdSignatureMessage,
} from '../../../src/crypto';
import { bigIntToHex } from '../../../src/crypto/field';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/{census,voteid_sig}.json (go-ethereum crypto).
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
interface VoteIdVectors {
  key: string;
  address: string;
  sigs: { vote_id: Int; r: string; s: string; v: number }[];
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

describe('vote id signatures', () => {
  const v = loadFixture<VoteIdVectors>('zkvm/voteid_sig.json');
  const voter = new Wallet(`0x${v.key}`);

  it('sign and recover like go-ethereum', async () => {
    expect(voter.address).toBe(getAddress(`0x${v.address}`));
    for (const c of v.sigs) {
      const vid = BigInt(c.vote_id);
      const sig = await signVoteId(voter, vid);
      expect(sig).toEqual({ r: `0x${c.r}`, s: `0x${c.s}`, v: c.v });
      expect(recoverVoteIdSigner(vid, sig)).toBe(voter.address);
      // v as 27/28, and the 65-byte wire form, recover the same signer.
      const wire = encodeEcdsaSignature(sig);
      expect(wire).toBe(`0x${c.r}${c.s}0${c.v}`);
      expect(decodeEcdsaSignature(wire)).toEqual(sig);
      expect(recoverVoteIdSigner(vid, wire)).toBe(voter.address);
      expect(recoverVoteIdSigner(vid, `0x${c.r}${c.s}${(27 + c.v).toString(16)}`)).toBe(
        voter.address
      );
      expect(recoverVoteIdSigner(vid ^ 1n, sig)).not.toBe(voter.address);
      for (const bad of [2, 3, 26, 29, 255]) {
        const hex = `0x${c.r}${c.s}${bad.toString(16).padStart(2, '0')}`;
        expect(() => recoverVoteIdSigner(vid, hex), `v = ${bad}`).toThrow('recovery id');
      }
      // The malleated twin recovers the same key but is refused.
      const twin = { r: sig.r, s: flipS(sig.s), v: (sig.v ^ 1) as 0 | 1 };
      expect(() => recoverVoteIdSigner(vid, twin)).toThrow('high-S');
      expect(() => recoverVoteIdSigner(vid, { ...sig, r: bigIntToHex(0n) })).toThrow('r out');
    }
  });

  it('normalize a high-S signer and refuse a signature from another key', async () => {
    const vid = BigInt(v.sigs[0].vote_id);
    const honest = await signVoteId(voter, vid);
    const twinHex = `${honest.r}${flipS(honest.s).slice(2)}${(28 - honest.v).toString(16)}`;
    const malleable = {
      signMessage: () => Promise.resolve(twinHex),
      getAddress: () => Promise.resolve(voter.address),
    } as unknown as Signer;
    expect(await signVoteId(malleable, vid)).toEqual(honest);
    const other = Wallet.createRandom();
    const impostor = {
      signMessage: (m: Uint8Array) => other.signMessage(m),
      getAddress: () => Promise.resolve(voter.address),
    } as unknown as Signer;
    await expect(signVoteId(impostor, vid)).rejects.toThrow('does not recover');
  });

  it('sign the 32-byte padded BE8 of the vote id', async () => {
    const vid = 0x8000000000001234n;
    const m = voteIdSignatureMessage(vid);
    expect(m).toHaveLength(32);
    expect(m.slice(0, 24).every(b => b === 0)).toBe(true);
    expect(Buffer.from(m.slice(24)).toString('hex')).toBe('8000000000001234');
    // The same bytes ethers signs as a personal message.
    const sig = decodeEcdsaSignature(await voter.signMessage(m));
    expect(recoverVoteIdSigner(vid, sig)).toBe(voter.address);
    await expect(signVoteId(voter, 5n)).rejects.toThrow('2^63');
  });
});
