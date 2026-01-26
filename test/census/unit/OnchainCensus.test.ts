import { OnchainCensus } from '../../../src/census/classes/OnchainCensus';
import { CensusOrigin } from '../../../src/census/types';

describe('OnchainCensus', () => {
  const validContractAddress = '0x1234567890123456789012345678901234567890';
  const validUri = 'https://api.studio.thegraph.com/query/12345/token-subgraph/v1.0.0';

  describe('Construction', () => {
    it('should create an OnchainCensus with Onchain origin', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect(census.censusOrigin).toBe(CensusOrigin.Onchain);
    });

    it('should be published immediately upon construction', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect(census.isPublished).toBe(true);
    });

    it('should NOT require publishing', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect(census.requiresPublishing).toBe(false);
    });

    it('should use 32-byte zero value as census root when contractAddress is set', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect(census.censusRoot).toBe('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('should use provided URI', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect(census.censusURI).toBe(validUri);
    });

    it('should accept different URI formats', () => {
      const customUri = 'https://subgraph.example.com/api/tokens';
      const census = new OnchainCensus(validContractAddress, customUri);
      expect(census.censusURI).toBe(customUri);
    });

    it('should store contract address', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect(census.contractAddress).toBe(validContractAddress);
    });
  });

  describe('Validation', () => {
    it('should reject invalid contract address format', () => {
      expect(() => new OnchainCensus('invalid', validUri)).toThrow('Contract address is missing or invalid');
    });

    it('should reject empty contract address', () => {
      expect(() => new OnchainCensus('', validUri)).toThrow('Contract address is missing or invalid');
    });

    it('should reject contract address with wrong length', () => {
      expect(() => new OnchainCensus('0x1234', validUri)).toThrow('Contract address is missing or invalid');
    });

    it('should accept contract address without 0x prefix', () => {
      const addressWithout0x = '1234567890123456789012345678901234567890';
      expect(() => new OnchainCensus(addressWithout0x, validUri)).not.toThrow();
    });

    it('should accept contract address with 0x prefix', () => {
      expect(() => new OnchainCensus(validContractAddress, validUri)).not.toThrow();
    });

    it('should reject empty URI', () => {
      expect(() => new OnchainCensus(validContractAddress, '')).toThrow('URI is required for onchain census');
    });
  });

  describe('Differences from MerkleCensus', () => {
    it('should not have a participants list', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect((census as any).participants).toBeUndefined();
    });

    it('should not have an add method', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect((census as any).add).toBeUndefined();
    });

    it('should not need publishing workflow', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      expect(census.requiresPublishing).toBe(false);
      expect(census.isPublished).toBe(true);
    });
  });

  describe('Ready for process creation', () => {
    it('should be immediately ready for process creation', () => {
      const census = new OnchainCensus(validContractAddress, validUri);
      
      // All required fields are available
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBeTruthy();
      expect(census.censusURI).toBeTruthy();
      expect(census.censusOrigin).toBe(CensusOrigin.Onchain);
    });
  });
});
