import { CspCensus, CensusType } from '../../../src/census/classes';
import { CensusOrigin } from '../../../src/census/types';

describe('CspCensus', () => {
  describe('constructor', () => {
    it('should create a CSP census with valid parameters', () => {
      const publicKey = '0x1234567890abcdef';
      const cspURI = 'https://csp-server.com';
      
      const census = new CspCensus(publicKey, cspURI);
      
      expect(census.type).toBe(CensusType.CSP);
      expect(census.publicKey).toBe(publicKey);
      expect(census.cspURI).toBe(cspURI);
    });

    it('should map to CSP census origin', () => {
      const census = new CspCensus('0x1234567890abcdef', 'https://csp-server.com');
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginCSP);
    });

    it('should be published immediately', () => {
      const publicKey = '0x1234567890abcdef';
      const cspURI = 'https://csp-server.com';
      
      const census = new CspCensus(publicKey, cspURI);
      
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBe(publicKey);
      expect(census.censusURI).toBe(cspURI);
    });

    it('should throw error for invalid public key format', () => {
      expect(() => new CspCensus('invalid-key', 'https://csp-server.com')).toThrow(
        'Public key is missing or invalid'
      );
      expect(() => new CspCensus('xyz123', 'https://csp-server.com')).toThrow(
        'Public key is missing or invalid'
      );
    });

    it('should throw error for empty public key', () => {
      expect(() => new CspCensus('', 'https://csp-server.com')).toThrow(
        'Public key is missing or invalid'
      );
    });

    it('should throw error for invalid URI', () => {
      expect(() => new CspCensus('0x1234567890abcdef', 'not-a-url')).toThrow(
        'CSP URI is missing or invalid'
      );
      expect(() => new CspCensus('0x1234567890abcdef', '')).toThrow(
        'CSP URI is missing or invalid'
      );
    });

    it('should accept public key with 0x prefix', () => {
      const census = new CspCensus('0x1234567890abcdef', 'https://csp-server.com');
      expect(census.publicKey).toBe('0x1234567890abcdef');
    });

    it('should accept public key without 0x prefix', () => {
      const census = new CspCensus('1234567890abcdef', 'https://csp-server.com');
      expect(census.publicKey).toBe('1234567890abcdef');
    });

    it('should accept various URI protocols', () => {
      expect(() => new CspCensus('0x1234', 'https://server.com')).not.toThrow();
      expect(() => new CspCensus('0x1234', 'http://server.com')).not.toThrow();
      expect(() => new CspCensus('0x1234', 'http://localhost:3000')).not.toThrow();
    });
  });

  describe('getters', () => {
    it('should return public key', () => {
      const publicKey = '0x1234567890abcdef';
      const census = new CspCensus(publicKey, 'https://csp-server.com');
      
      expect(census.publicKey).toBe(publicKey);
    });

    it('should return CSP URI', () => {
      const cspURI = 'https://csp-server.com';
      const census = new CspCensus('0x1234567890abcdef', cspURI);
      
      expect(census.cspURI).toBe(cspURI);
    });

    it('should use public key as census root', () => {
      const publicKey = '0x1234567890abcdef';
      const census = new CspCensus(publicKey, 'https://csp-server.com');
      
      expect(census.censusRoot).toBe(publicKey);
    });

    it('should use CSP URI as census URI', () => {
      const cspURI = 'https://csp-server.com';
      const census = new CspCensus('0x1234567890abcdef', cspURI);
      
      expect(census.censusURI).toBe(cspURI);
    });
  });
});
