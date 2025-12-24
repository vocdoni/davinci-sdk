import { PlainCensus, CensusType } from '../../../src/census/classes';
import { CensusOrigin } from '../../../src/census/types';

describe('PlainCensus', () => {
  describe('constructor', () => {
    it('should create a plain census with correct type', () => {
      const census = new PlainCensus();
      expect(census.type).toBe(CensusType.PLAIN);
      expect(census.isPublished).toBe(false);
      expect(census.censusId).toBeNull();
      expect(census.censusRoot).toBeNull();
      expect(census.censusURI).toBeNull();
      expect(census.size).toBeNull();
    });

    it('should map to MerkleTree census origin', () => {
      const census = new PlainCensus();
      expect(census.censusOrigin).toBe(CensusOrigin.OffchainStatic);
    });
  });

  describe('add', () => {
    it('should add a single address', () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      
      expect(census.addresses.length).toBe(1);
      expect(census.participants.length).toBe(1);
      expect(census.participants[0]).toEqual({
        key: '0x1234567890123456789012345678901234567890',
        weight: '1',
      });
    });

    it('should add multiple addresses', () => {
      const census = new PlainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ]);
      
      expect(census.addresses.length).toBe(2);
      expect(census.participants.length).toBe(2);
    });

    it('should convert addresses to lowercase', () => {
      const census = new PlainCensus();
      census.add('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
      
      expect(census.addresses[0]).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

    it('should deduplicate addresses', () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      census.add('0x1234567890123456789012345678901234567890');
      
      expect(census.addresses.length).toBe(1);
    });

    it('should deduplicate case-insensitive addresses', () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      census.add('0x1234567890123456789012345678901234567890'.toUpperCase());
      
      expect(census.addresses.length).toBe(1);
    });

    it('should throw error for invalid address format', () => {
      const census = new PlainCensus();
      expect(() => census.add('invalid')).toThrow('Invalid Ethereum address format');
      expect(() => census.add('0x123')).toThrow('Invalid Ethereum address format');
    });

    it('should throw error for empty address', () => {
      const census = new PlainCensus();
      expect(() => census.add('')).toThrow('Address is required');
    });

    it('should assign weight=1 to all addresses', () => {
      const census = new PlainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        '0x9876543210987654321098765432109876543210',
      ]);
      
      census.participants.forEach(participant => {
        expect(participant.weight).toBe('1');
      });
    });
  });

  describe('remove', () => {
    it('should remove an address', () => {
      const census = new PlainCensus();
      const address = '0x1234567890123456789012345678901234567890';
      census.add(address);
      census.remove(address);
      
      expect(census.addresses.length).toBe(0);
    });

    it('should be case-insensitive when removing', () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      census.remove('0x1234567890123456789012345678901234567890'.toUpperCase());
      
      expect(census.addresses.length).toBe(0);
    });

    it('should not error when removing non-existent address', () => {
      const census = new PlainCensus();
      expect(() => census.remove('0x1234567890123456789012345678901234567890')).not.toThrow();
    });
  });

  describe('participants', () => {
    it('should return participants with weight=1', () => {
      const census = new PlainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ]);
      
      const participants = census.participants;
      expect(participants).toHaveLength(2);
      participants.forEach(p => {
        expect(p).toHaveProperty('key');
        expect(p).toHaveProperty('weight');
        expect(p.weight).toBe('1');
      });
    });
  });

  describe('_setPublishedData', () => {
    it('should set published data', () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      
      census._setPublishedData(
        '0xroot123',
        'ipfs://uri123',
        1,
        'census-id-123'
      );
      
      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBe('0xroot123');
      expect(census.censusURI).toBe('ipfs://uri123');
      expect(census.size).toBe(1);
      expect(census.censusId).toBe('census-id-123');
    });
  });
});
