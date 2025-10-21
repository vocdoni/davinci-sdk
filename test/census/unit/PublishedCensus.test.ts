import { PublishedCensus, CensusType } from '../../../src/census/classes';
import { CensusOrigin } from '../../../src/census/types';

describe('PublishedCensus', () => {
  describe('constructor', () => {
    it('should create a published census with all data', () => {
      const census = new PublishedCensus(
        CensusType.WEIGHTED,
        '0xroot123',
        'ipfs://uri123',
        100
      );
      
      expect(census.type).toBe(CensusType.WEIGHTED);
      expect(census.censusRoot).toBe('0xroot123');
      expect(census.censusURI).toBe('ipfs://uri123');
      expect(census.size).toBe(100);
      expect(census.isPublished).toBe(true);
    });

    it('should create a plain published census', () => {
      const census = new PublishedCensus(
        CensusType.PLAIN,
        '0xroot456',
        'ipfs://uri456',
        50
      );
      
      expect(census.type).toBe(CensusType.PLAIN);
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginMerkleTree);
    });

    it('should create a weighted published census', () => {
      const census = new PublishedCensus(
        CensusType.WEIGHTED,
        '0xroot789',
        'ipfs://uri789',
        200
      );
      
      expect(census.type).toBe(CensusType.WEIGHTED);
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginMerkleTree);
    });

    it('should create a CSP published census', () => {
      const census = new PublishedCensus(
        CensusType.CSP,
        '0xpubkey',
        'https://csp-server.com',
        0
      );
      
      expect(census.type).toBe(CensusType.CSP);
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginCSP);
    });
  });

  describe('getters', () => {
    it('should return census root', () => {
      const census = new PublishedCensus(
        CensusType.WEIGHTED,
        '0xroot123',
        'ipfs://uri123',
        100
      );
      
      expect(census.censusRoot).toBe('0xroot123');
    });

    it('should return census URI', () => {
      const census = new PublishedCensus(
        CensusType.WEIGHTED,
        '0xroot123',
        'ipfs://uri123',
        100
      );
      
      expect(census.censusURI).toBe('ipfs://uri123');
    });

    it('should return census size', () => {
      const census = new PublishedCensus(
        CensusType.WEIGHTED,
        '0xroot123',
        'ipfs://uri123',
        100
      );
      
      expect(census.size).toBe(100);
    });

    it('should be published', () => {
      const census = new PublishedCensus(
        CensusType.WEIGHTED,
        '0xroot123',
        'ipfs://uri123',
        100
      );
      
      expect(census.isPublished).toBe(true);
    });
  });

  describe('censusOrigin', () => {
    it('should map PLAIN to MerkleTree', () => {
      const census = new PublishedCensus(
        CensusType.PLAIN,
        '0xroot',
        'ipfs://uri',
        10
      );
      
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginMerkleTree);
    });

    it('should map WEIGHTED to MerkleTree', () => {
      const census = new PublishedCensus(
        CensusType.WEIGHTED,
        '0xroot',
        'ipfs://uri',
        10
      );
      
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginMerkleTree);
    });

    it('should map CSP to CSP', () => {
      const census = new PublishedCensus(
        CensusType.CSP,
        '0xpubkey',
        'https://csp.com',
        0
      );
      
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginCSP);
    });
  });
});
