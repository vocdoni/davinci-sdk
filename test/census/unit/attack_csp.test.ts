import { Wallet } from 'ethers';
import { CensusOrigin, CensusWitnessError, checkCensusWitness } from '../../../src/census';
import { signCspAttestation, type CspAttestation } from '../../../src/crypto';

const PID = `0x${'ab'.repeat(31)}`;
const VOTER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const CSP = new Wallet(`0x${'33'.repeat(32)}`);
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const hex32 = (x: bigint) => `0x${x.toString(16).padStart(64, '0')}`;

const process = {
  processId: PID,
  census: { origin: CensusOrigin.CSP, root: BigInt(CSP.address) },
};

async function attest(over: Partial<{ address: string; weight: bigint; index: bigint }> = {}) {
  return signCspAttestation(CSP, {
    processId: PID,
    address: over.address ?? VOTER,
    weight: over.weight ?? 5n,
    index: over.index ?? 7n,
  });
}

// The same signature as its high-S twin: same key recovers, with the other recovery id.
const highS = (a: CspAttestation): CspAttestation => ({
  ...a,
  s: hex32(N - BigInt(a.s)),
  recid: (a.recid ^ 1) as 0 | 1,
});
const eth = (a: CspAttestation): CspAttestation => ({ ...a, recid: (a.recid + 27) as never });

describe('attack: CSP attestations in other valid spellings', () => {
  it('the plain low-S attestation passes', async () => {
    const a = await attest();
    const out = await checkCensusWitness(process, VOTER, { type: 'csp', attestation: a });
    expect(out.weight).toBe(5n);
  });

  // BUG: the node folds a high-S s and maps v 27/28 to 0/1 (state validate.rs low_s); the SDK refuses both.
  it('takes the Ethereum spelling v = 27/28 and sends the canonical one', async () => {
    const a = await attest();
    const out = await checkCensusWitness(process, VOTER, { type: 'csp', attestation: eth(a) });
    expect(out.censusProof).toMatchObject({ type: 'csp', r: a.r, s: a.s, recid: a.recid });
  });

  it('takes a high-S twin and sends the low-S form', async () => {
    const a = await attest();
    const twin = highS(a);
    const out = await checkCensusWitness(process, VOTER, { type: 'csp', attestation: twin });
    expect(out.censusProof).toMatchObject({ type: 'csp', r: a.r, s: a.s, recid: a.recid });
    const both = await checkCensusWitness(process, VOTER, { type: 'csp', attestation: eth(twin) });
    expect(both.censusProof).toMatchObject({ type: 'csp', s: a.s, recid: a.recid });
  });
});

describe('attack: forged or mismatched CSP attestations', () => {
  const refuse = (voter: string, a: CspAttestation, root = process.census.root) =>
    expect(
      checkCensusWitness({ ...process, census: { origin: CensusOrigin.CSP, root } }, voter, {
        type: 'csp',
        attestation: a,
      })
    ).rejects.toThrow(CensusWitnessError);

  it('refuses another voter, weight, index, process or CSP', async () => {
    const a = await attest();
    await refuse(OTHER, a);
    await refuse(VOTER, { ...a, address: OTHER });
    await refuse(VOTER, { ...a, weight: 6n });
    await refuse(VOTER, { ...a, index: 8n });
    await refuse(VOTER, a, BigInt(new Wallet(`0x${'44'.repeat(32)}`).address));
    // A root with high bits set is not an address.
    await refuse(VOTER, a, BigInt(CSP.address) | (1n << 160n));
    await expect(
      checkCensusWitness({ processId: `0x${'cd'.repeat(31)}`, census: process.census }, VOTER, {
        type: 'csp',
        attestation: a,
      })
    ).rejects.toThrow(CensusWitnessError);
  });

  it('refuses indexes outside the ballot namespace and weights past 88 bits', async () => {
    const a = await attest();
    await refuse(VOTER, { ...a, index: (1n << 63n) - 0x10n });
    await refuse(VOTER, { ...a, index: 1n << 64n });
    await refuse(VOTER, { ...a, index: 1n << 53n });
    await refuse(VOTER, { ...a, index: -1n });
    await refuse(VOTER, { ...a, weight: 1n << 88n });
    await refuse(VOTER, { ...a, weight: 1n << 128n });
  });

  it('refuses r, s out of range, zero, and garbage recovery ids', async () => {
    const a = await attest();
    await refuse(VOTER, { ...a, r: hex32(0n) });
    await refuse(VOTER, { ...a, s: hex32(0n) });
    await refuse(VOTER, { ...a, r: hex32(N) });
    await refuse(VOTER, { ...a, s: hex32(N) });
    await refuse(VOTER, { ...a, recid: 2 as never });
    await refuse(VOTER, { ...a, recid: 29 as never });
    await refuse(VOTER, { ...a, recid: 255 as never });
    await refuse(VOTER, { ...a, recid: -1 as never });
    await refuse(VOTER, { ...a, r: '0x12' });
    await refuse(VOTER, { ...a, s: 'zz' });
  });

  it('refuses a Merkle witness for a CSP census and the reverse', async () => {
    await expect(
      checkCensusWitness(process, VOTER, { type: 'merkle', weight: 5n })
    ).rejects.toThrow(CensusWitnessError);
    await expect(checkCensusWitness(process, VOTER, { type: 'other' } as never)).rejects.toThrow(
      CensusWitnessError
    );
    await expect(checkCensusWitness(process, VOTER, null as never)).rejects.toThrow();
  });
});
