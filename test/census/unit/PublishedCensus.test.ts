import { CensusError, CensusOrigin, PublishedCensus } from '../../../src/census';
import { BN254_FR } from '../../../src/crypto';

describe('PublishedCensus', () => {
  // A Keccak root above the BN254 modulus, as every wire writes it.
  const root = `0x${'e7'.repeat(32)}`;
  const uri = 'https://files.example.org/census.json';

  it('holds a Merkle root, as bytes32, and its URL', () => {
    expect(BigInt(root) >= BN254_FR).toBe(true);
    for (const origin of [CensusOrigin.OffchainStatic, CensusOrigin.OffchainDynamic]) {
      const census = new PublishedCensus(origin, root, uri);
      expect(census.censusOrigin).toBe(origin);
      expect(census.censusRoot).toBe(root);
      expect(census.censusURI).toBe(uri);
      expect(census.isPublished).toBe(true);
      expect(census.toRegistryCensus()).toEqual({ origin, root, uri });
    }
    // Either case of the digits; written lowercase.
    const upper = `0x${'E7'.repeat(32)}`;
    expect(new PublishedCensus(CensusOrigin.OffchainStatic, upper, uri).censusRoot).toBe(root);
    expect(new PublishedCensus(CensusOrigin.OffchainStatic, 0x1234n, uri).censusRoot).toBe(
      `0x${'1234'.padStart(64, '0')}`
    );
    const top = (1n << 256n) - 1n;
    expect(new PublishedCensus(CensusOrigin.OffchainStatic, top, uri).censusRoot).toBe(
      `0x${'ff'.repeat(32)}`
    );
  });

  it('holds a CSP address', () => {
    const address = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
    const census = new PublishedCensus(CensusOrigin.CSP, address, 'https://csp.example.org');
    expect(census.censusRoot).toBe(`0x${'00'.repeat(12)}${address.slice(2)}`);
    expect(census.requiresPublishing).toBe(false);
  });

  it('refuses roots the registry or the nodes refuse', () => {
    const refused: [CensusOrigin, string | bigint, string][] = [
      [CensusOrigin.OffchainStatic, 0n, 'non-zero 256-bit value'],
      [CensusOrigin.OffchainStatic, -1n, 'non-zero 256-bit value'],
      [CensusOrigin.OffchainStatic, 1n << 256n, 'non-zero 256-bit value'],
      [CensusOrigin.OffchainStatic, `0x${'00'.repeat(32)}`, 'non-zero 256-bit value'],
      [CensusOrigin.OffchainDynamic, '0x', '0x and 64 hex digits'],
      [CensusOrigin.OffchainStatic, '0x1234', '0x and 64 hex digits'],
      [CensusOrigin.OffchainStatic, root.slice(2), '0x and 64 hex digits'],
      [CensusOrigin.OffchainStatic, `0X${root.slice(2)}`, '0x and 64 hex digits'],
      [CensusOrigin.OffchainStatic, `${root}00`, '0x and 64 hex digits'],
      [CensusOrigin.OffchainStatic, BN254_FR.toString(), '0x and 64 hex digits'],
      [CensusOrigin.CSP, 1n << 160n, 'the CSP address'],
      [CensusOrigin.CSP, 0n, 'the CSP address'],
      [CensusOrigin.CSP, '1234', 'is not a bigint or 0x hex'],
      [CensusOrigin.Onchain, 0n, 'use OnchainCensus'],
      [9 as CensusOrigin, 1n, 'unknown census origin'],
    ];
    for (const [origin, r, msg] of refused) {
      expect(() => new PublishedCensus(origin, r, uri), String(r)).toThrow(msg);
    }
    expect(() => new PublishedCensus(CensusOrigin.OffchainStatic, root, '')).toThrow(CensusError);
  });
});
