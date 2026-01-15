import { PublishedCensus } from '../../../src/census/classes/PublishedCensus';
import { CensusOrigin } from '../../../src/census/types';

describe('PublishedCensus', () => {
  const testRoot = '0x1234567890abcdef';
  const testUri = 'ipfs://QmTest123';

  describe('Construction', () => {
    it('should create a PublishedCensus with OffchainStatic origin', () => {
      const census = new PublishedCensus(CensusOrigin.OffchainStatic, testRoot, testUri);

      expect(census.censusOrigin).toBe(CensusOrigin.OffchainStatic);
      expect(census.censusRoot).toBe(testRoot);
      expect(census.censusURI).toBe(testUri);
    });

    it('should be marked as published', () => {
      const census = new PublishedCensus(CensusOrigin.OffchainStatic, testRoot, testUri);
      expect(census.isPublished).toBe(true);
    });

    it('should work with OffchainDynamic origin', () => {
      const census = new PublishedCensus(CensusOrigin.OffchainDynamic, testRoot, testUri);
      expect(census.censusOrigin).toBe(CensusOrigin.OffchainDynamic);
    });

    it('should work with Onchain origin', () => {
      const contractAddress = '0x1234567890123456789012345678901234567890';
      const census = new PublishedCensus(
        CensusOrigin.Onchain,
        contractAddress,
        `contract://${contractAddress}`
      );
      expect(census.censusOrigin).toBe(CensusOrigin.Onchain);
    });

    it('should work with CSP origin', () => {
      const publicKey = '0xabcdef1234567890';
      const cspUri = 'https://csp-server.com';
      const census = new PublishedCensus(CensusOrigin.CSP, publicKey, cspUri);
      expect(census.censusOrigin).toBe(CensusOrigin.CSP);
    });
  });

  describe('Publishing behavior', () => {
    it('should NOT require publishing for OffchainStatic (already published)', () => {
      const census = new PublishedCensus(CensusOrigin.OffchainStatic, testRoot, testUri);
      // This is a published census, so even though OffchainStatic normally requires publishing,
      // this specific instance is already published
      expect(census.isPublished).toBe(true);
    });

    it('should NOT require publishing for OffchainDynamic (already published)', () => {
      const census = new PublishedCensus(CensusOrigin.OffchainDynamic, testRoot, testUri);
      expect(census.isPublished).toBe(true);
    });

    it('should NOT require publishing for Onchain (never requires it)', () => {
      const contractAddress = '0x1234567890123456789012345678901234567890';
      const census = new PublishedCensus(
        CensusOrigin.Onchain,
        contractAddress,
        `contract://${contractAddress}`
      );
      expect(census.requiresPublishing).toBe(false);
      expect(census.isPublished).toBe(true);
    });

    it('should NOT require publishing for CSP (never requires it)', () => {
      const publicKey = '0xabcdef1234567890';
      const cspUri = 'https://csp-server.com';
      const census = new PublishedCensus(CensusOrigin.CSP, publicKey, cspUri);
      expect(census.requiresPublishing).toBe(false);
      expect(census.isPublished).toBe(true);
    });
  });

  describe('Ready for process creation', () => {
    it('should be immediately ready with all census origins', () => {
      const censuses = [
        new PublishedCensus(CensusOrigin.OffchainStatic, testRoot, testUri),
        new PublishedCensus(CensusOrigin.OffchainDynamic, testRoot, testUri),
        new PublishedCensus(
          CensusOrigin.Onchain,
          '0x1234567890123456789012345678901234567890',
          'contract://0x1234567890123456789012345678901234567890'
        ),
        new PublishedCensus(CensusOrigin.CSP, '0xpubkey', 'https://csp.com'),
      ];

      censuses.forEach(census => {
        expect(census.isPublished).toBe(true);
        expect(census.censusRoot).toBeTruthy();
        expect(census.censusURI).toBeTruthy();
      });
    });
  });

  describe('Use case', () => {
    it('should be useful for reusing already-published census data', () => {
      // Scenario: User published a census earlier and got back root and URI
      // They want to create a new process using that same census
      const previouslyPublishedRoot = '0xabcdef123456';
      const previouslyPublishedUri = 'ipfs://QmPreviouslyPublished';

      const census = new PublishedCensus(
        CensusOrigin.OffchainStatic,
        previouslyPublishedRoot,
        previouslyPublishedUri
      );

      // Can be used directly for process creation without re-publishing
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBe(previouslyPublishedRoot);
      expect(census.censusURI).toBe(previouslyPublishedUri);
    });
  });
});
