import { CensusError, CensusOrigin, PublishedCensus } from '../../../src/census';
import { BN254_FR } from '../../../src/crypto';

describe('PublishedCensus', () => {
  const root = '0x1234567890abcdef';
  const uri = 'https://files.example.org/census.json';
  const padded = `0x${'1234567890abcdef'.padStart(64, '0')}`;

  it('holds a Merkle root, as bytes32, and its URL', () => {
    for (const origin of [CensusOrigin.OffchainStatic, CensusOrigin.OffchainDynamic]) {
      const census = new PublishedCensus(origin, root, uri);
      expect(census.censusOrigin).toBe(origin);
      expect(census.censusRoot).toBe(padded);
      expect(census.censusURI).toBe(uri);
      expect(census.isPublished).toBe(true);
      expect(census.toRegistryCensus()).toEqual({ origin, root: padded, uri });
    }
    expect(new PublishedCensus(CensusOrigin.OffchainStatic, 0x1234n, uri).censusRoot).toBe(
      `0x${'1234'.padStart(64, '0')}`
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
      [CensusOrigin.OffchainStatic, 0n, 'non-zero field element'],
      [CensusOrigin.OffchainStatic, BN254_FR, 'non-zero field element'],
      [CensusOrigin.OffchainDynamic, '0x', 'is not a bigint or 0x hex'],
      [CensusOrigin.OffchainStatic, '1234', 'is not a bigint or 0x hex'],
      [CensusOrigin.CSP, 1n << 160n, 'the CSP address'],
      [CensusOrigin.CSP, 0n, 'the CSP address'],
      [CensusOrigin.Onchain, 0n, 'use OnchainCensus'],
      [9 as CensusOrigin, 1n, 'unknown census origin'],
    ];
    for (const [origin, r, msg] of refused) {
      expect(() => new PublishedCensus(origin, r, uri), String(r)).toThrow(msg);
    }
    expect(() => new PublishedCensus(CensusOrigin.OffchainStatic, root, '')).toThrow(CensusError);
  });
});
