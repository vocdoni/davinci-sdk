import { Wallet, getAddress, zeroPadValue } from 'ethers';
import {
  CensusError,
  CensusOrigin,
  CensusWitnessError,
  CspCensus,
  CspSigner,
  checkCensusWitness,
} from '../../../src/census';
import { recoverCspSigner, signCspAttestation } from '../../../src/crypto';
import { bigIntToHex } from '../../../src/crypto/field';
import { loadFixture } from '../../helpers/fixtures';

// davinci-zkvm rust-sdk/testdata/census.json: CSP attestations (go-ethereum).
interface CspVectors {
  csp_key: string;
  csp_address: string;
  csp: {
    process_id: string;
    address: string;
    weight: string;
    index: string | number;
    r: string;
    s: string;
    recid: number;
  }[];
}

const v = loadFixture<CspVectors>('zkvm/census.json');
const cspWallet = new Wallet(`0x${v.csp_key}`);
const PID = bigIntToHex(BigInt(v.csp[0].process_id), 31);
const URI = 'https://csp.example.org/process';
const VOTER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

describe('CspCensus', () => {
  it('has the CSP address, left-padded, as its root', () => {
    const census = new CspCensus(cspWallet.address.toLowerCase(), URI);
    expect(census.censusOrigin).toBe(CensusOrigin.CSP);
    expect(census.requiresPublishing).toBe(false);
    expect(census.isPublished).toBe(true);
    expect(census.cspAddress).toBe(cspWallet.address);
    expect(census.censusRoot).toBe(zeroPadValue(cspWallet.address, 32).toLowerCase());
    expect(census.censusURI).toBe(URI);
    expect(census.toRegistryCensus()).toEqual({
      origin: CensusOrigin.CSP,
      root: `0x${'00'.repeat(12)}${v.csp_address}`,
      uri: URI,
    });
  });

  it('refuses a bad address or URI, and comes from a signer', async () => {
    expect(() => new CspCensus('0x1234', URI)).toThrow(CensusError);
    expect(() => new CspCensus(cspWallet.address, '')).toThrow('CSP URI');
    expect(() => new CspCensus(cspWallet.address, 'not a url')).toThrow('CSP URI');
    const census = await CspCensus.fromSigner(cspWallet, URI);
    expect(census.cspAddress).toBe(cspWallet.address);
  });
});

describe('CspSigner', () => {
  it('signs the Rust attestations and its census is its address', async () => {
    const csp = new CspSigner(cspWallet);
    expect(await csp.address()).toBe(getAddress(`0x${v.csp_address}`));
    expect((await csp.census(URI)).cspAddress).toBe(cspWallet.address);
    for (const c of v.csp) {
      const processId = bigIntToHex(BigInt(c.process_id), 31);
      const a = await csp.attest({
        processId,
        address: `0x${c.address}`,
        weight: BigInt(c.weight),
        index: BigInt(c.index),
      });
      expect([a.r, a.s, a.recid, a.index]).toEqual([
        `0x${c.r}`,
        `0x${c.s}`,
        c.recid,
        BigInt(c.index),
      ]);
      expect(recoverCspSigner(processId, a)).toBe(cspWallet.address);
    }
  });

  it('gives each voter one index of its own, per process', async () => {
    const csp = new CspSigner(Wallet.createRandom());
    const other = `0x${'bb'.repeat(31)}`;
    expect((await csp.attest({ processId: PID, address: VOTER })).index).toBe(0n);
    expect((await csp.attest({ processId: PID, address: OTHER, weight: 3n })).index).toBe(1n);
    // The same voter again: the same index and weight.
    const again = await csp.attest({ processId: PID, address: VOTER, weight: 1n });
    expect([again.index, again.weight]).toEqual([0n, 1n]);
    expect(csp.indexOf(PID.toUpperCase().replace('0X', '0x'), VOTER.toLowerCase())).toBe(0n);
    // Another process starts over.
    expect((await csp.attest({ processId: other, address: OTHER })).index).toBe(0n);
    // An explicit index is kept, and skipped by the counter.
    const third = '0x3333333333333333333333333333333333333333';
    expect((await csp.attest({ processId: PID, address: third, index: 2n })).index).toBe(2n);
    const fourth = '0x4444444444444444444444444444444444444444';
    expect((await csp.attest({ processId: PID, address: fourth })).index).toBe(3n);
    await expect(csp.attest({ processId: PID, address: VOTER, index: 7n })).rejects.toThrow(
      'already has index 0'
    );
    await expect(
      csp.attest({
        processId: PID,
        address: '0x5555555555555555555555555555555555555555',
        index: 1n,
      })
    ).rejects.toThrow(`index 1 already belongs to ${getAddress(OTHER)}`);
    await expect(
      csp.attest({ processId: other, address: VOTER, index: 1n << 53n })
    ).rejects.toThrow('outside [0, 2^53 - 1]');
    await expect(
      csp.attest({ processId: other, address: VOTER, weight: 1n << 88n })
    ).rejects.toThrow('88 bits');
    expect(csp.indexOf(other, VOTER)).toBeUndefined();
  });

  it('pins the weight of each voter with its index', async () => {
    const csp = new CspSigner(Wallet.createRandom());
    const other = `0x${'bb'.repeat(31)}`;
    const first = await csp.attest({ processId: PID, address: VOTER, weight: 5n });
    expect(csp.weightOf(PID, VOTER)).toBe(5n);
    // Omitted, the weight is the one already given; another one is refused.
    const again = await csp.attest({ processId: PID, address: VOTER });
    expect([again.index, again.weight, again.r]).toEqual([first.index, 5n, first.r]);
    for (const weight of [1n, 6n, 1n << 80n]) {
      await expect(csp.attest({ processId: PID, address: VOTER, weight })).rejects.toThrow(
        `${getAddress(VOTER)} already has weight 5`
      );
    }
    await expect(
      csp.attest({ processId: PID, address: VOTER, weight: 6n, index: first.index })
    ).rejects.toThrow('already has weight 5');
    // A refused request records nothing, and another process pins its own weight.
    expect(csp.weightOf(PID, VOTER)).toBe(5n);
    expect((await csp.attest({ processId: other, address: VOTER, weight: 9n })).weight).toBe(9n);
    expect(csp.weightOf(other, OTHER)).toBeUndefined();
    // A new voter defaults to weight 1.
    expect((await csp.attest({ processId: PID, address: OTHER })).weight).toBe(1n);
  });

  it('never hands one index to two concurrent requests', async () => {
    const csp = new CspSigner(Wallet.createRandom());
    const voters = Array.from(
      { length: 8 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`
    );
    const out = await Promise.all(voters.map(address => csp.attest({ processId: PID, address })));
    expect(new Set(out.map(a => a.index)).size).toBe(voters.length);
  });
});

describe('checkCensusWitness for a CSP census', () => {
  const census = {
    origin: CensusOrigin.CSP,
    root: zeroPadValue(cspWallet.address, 32),
  };
  const csp = new CspSigner(cspWallet);

  it('returns the weight and the attestation the vote carries', async () => {
    const witness = await csp.witness({ processId: PID, address: VOTER, weight: 4n, index: 9n });
    const checked = await checkCensusWitness({ processId: PID, census }, VOTER, witness);
    const a = witness.attestation;
    expect(checked).toEqual({
      weight: 4n,
      censusProof: { type: 'csp', r: a.r, s: a.s, recid: a.recid, index: 9n },
    });
  });

  it('refuses an attestation for another voter, CSP, process or census', async () => {
    const witness = await csp.witness({ processId: PID, address: OTHER, index: 10n });
    const refuse = (p: Promise<unknown>) => expect(p).rejects.toThrow(CensusWitnessError);
    await refuse(checkCensusWitness({ processId: PID, census }, VOTER, witness));
    const rogue = await new CspSigner(Wallet.createRandom()).witness({
      processId: PID,
      address: VOTER,
    });
    await refuse(checkCensusWitness({ processId: PID, census }, VOTER, rogue));
    await refuse(checkCensusWitness({ processId: `0x${'cd'.repeat(31)}`, census }, OTHER, witness));
    // The CSP address with a bit above 160 set is not a CSP root.
    const high = { ...census, root: BigInt(census.root) | (1n << 200n) };
    await refuse(checkCensusWitness({ processId: PID, census: high }, OTHER, witness));
    await refuse(
      checkCensusWitness(
        { processId: PID, census: { ...census, origin: CensusOrigin.OffchainStatic } },
        OTHER,
        witness
      )
    );
    // A valid attestation whose index does not fit a JSON number.
    const wide = await signCspAttestation(cspWallet, {
      processId: PID,
      address: OTHER,
      weight: 1n,
      index: 1n << 53n,
    });
    await expect(
      checkCensusWitness({ processId: PID, census }, OTHER, { type: 'csp', attestation: wide })
    ).rejects.toThrow('does not fit a JSON number');
    // An index past a JSON number, and a tampered weight.
    const far = await csp.witness({ processId: `0x${'ee'.repeat(31)}`, address: OTHER, index: 5n });
    await refuse(
      checkCensusWitness({ processId: `0x${'ee'.repeat(31)}`, census }, OTHER, {
        type: 'csp',
        attestation: { ...far.attestation, index: 1n << 53n },
      })
    );
    await refuse(
      checkCensusWitness({ processId: PID, census }, OTHER, {
        type: 'csp',
        attestation: { ...witness.attestation, weight: 2n },
      })
    );
    await refuse(
      checkCensusWitness({ processId: PID, census }, OTHER, {
        type: 'csp',
        attestation: { ...witness.attestation, recid: 2 as 0 },
      })
    );
  });
});
