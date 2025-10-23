import { CspCensus, CensusType } from '../../../src/census/classes';
import { CensusOrigin } from '../../../src/census/types';

describe('CspCensus', () => {
  describe('constructor', () => {
    it('should create a CSP census with valid parameters', () => {
      const publicKey = '0x1234567890abcdef';
      const cspURI = 'https://csp-server.com';
      const size = 100;
      
      const census = new CspCensus(publicKey, cspURI, size);
      
      expect(census.type).toBe(CensusType.CSP);
      expect(census.publicKey).toBe(publicKey);
      expect(census.cspURI).toBe(cspURI);
      expect(census.size).toBe(size);
    });

    it('should map to CSP census origin', () => {
      const census = new CspCensus('0x1234567890abcdef', 'https://csp-server.com', 100);
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginCSP);
    });

    it('should be published immediately', () => {
      const publicKey = '0x1234567890abcdef';
      const cspURI = 'https://csp-server.com';
      
      const census = new CspCensus(publicKey, cspURI, 100);
      
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBe(publicKey);
      expect(census.censusURI).toBe(cspURI);
    });

    it('should throw error for invalid public key format', () => {
      expect(() => new CspCensus('invalid-key', 'https://csp-server.com', 100)).toThrow(
        'Public key is missing or invalid'
      );
      expect(() => new CspCensus('xyz123', 'https://csp-server.com', 100)).toThrow(
        'Public key is missing or invalid'
      );
    });

    it('should throw error for empty public key', () => {
      expect(() => new CspCensus('', 'https://csp-server.com', 100)).toThrow(
        'Public key is missing or invalid'
      );
    });

    it('should throw error for invalid URI', () => {
      expect(() => new CspCensus('0x1234567890abcdef', 'not-a-url', 100)).toThrow(
        'CSP URI is missing or invalid'
      );
      expect(() => new CspCensus('0x1234567890abcdef', '', 100)).toThrow(
        'CSP URI is missing or invalid'
      );
    });

    it('should accept public key with 0x prefix', () => {
      const census = new CspCensus('0x1234567890abcdef', 'https://csp-server.com', 100);
      expect(census.publicKey).toBe('0x1234567890abcdef');
    });

    it('should accept public key without 0x prefix', () => {
      const census = new CspCensus('1234567890abcdef', 'https://csp-server.com', 100);
      expect(census.publicKey).toBe('1234567890abcdef');
    });

    it('should accept various URI protocols', () => {
      expect(() => new CspCensus('0x1234', 'https://server.com', 100)).not.toThrow();
      expect(() => new CspCensus('0x1234', 'http://server.com', 100)).not.toThrow();
      expect(() => new CspCensus('0x1234', 'http://localhost:3000', 100)).not.toThrow();
    });
  });

  describe('getters', () => {
    it('should return public key', () => {
      const publicKey = '0x1234567890abcdef';
      const census = new CspCensus(publicKey, 'https://csp-server.com', 100);
      
      expect(census.publicKey).toBe(publicKey);
    });

    it('should return CSP URI', () => {
      const cspURI = 'https://csp-server.com';
      const census = new CspCensus('0x1234567890abcdef', cspURI, 100);
      
      expect(census.cspURI).toBe(cspURI);
    });

    it('should use public key as census root', () => {
      const publicKey = '0x1234567890abcdef';
      const census = new CspCensus(publicKey, 'https://csp-server.com', 100);
      
      expect(census.censusRoot).toBe(publicKey);
    });

    it('should use CSP URI as census URI', () => {
      const cspURI = 'https://csp-server.com';
      const census = new CspCensus('0x1234567890abcdef', cspURI, 100);
      
      expect(census.censusURI).toBe(cspURI);
    });

    it('should store the provided size', () => {
      const size = 250;
      const census = new CspCensus('0x1234567890abcdef', 'https://csp-server.com', size);
      
      expect(census.size).toBe(size);
    });
  });
});
