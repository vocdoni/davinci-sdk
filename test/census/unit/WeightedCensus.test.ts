import { WeightedCensus, CensusType } from '../../../src/census/classes';
import { CensusOrigin } from '../../../src/census/types';

describe('WeightedCensus', () => {
  describe('constructor', () => {
    it('should create a weighted census with correct type', () => {
      const census = new WeightedCensus();
      expect(census.type).toBe(CensusType.WEIGHTED);
      expect(census.isPublished).toBe(false);
      expect(census.censusId).toBeNull();
      expect(census.censusRoot).toBeNull();
      expect(census.censusURI).toBeNull();
      expect(census.size).toBeNull();
    });

    it('should map to MerkleTree census origin', () => {
      const census = new WeightedCensus();
      expect(census.censusOrigin).toBe(CensusOrigin.CensusOriginMerkleTree);
    });
  });

  describe('add', () => {
    it('should add a single participant with custom weight', () => {
      const census = new WeightedCensus();
      census.add({
        key: '0x1234567890123456789012345678901234567890',
        weight: '5',
      });
      
      expect(census.addresses.length).toBe(1);
      expect(census.participants.length).toBe(1);
      expect(census.participants[0]).toEqual({
        key: '0x1234567890123456789012345678901234567890',
        weight: '5',
      });
    });

    it('should add multiple participants', () => {
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '10' },
      ]);
      
      expect(census.addresses.length).toBe(2);
      expect(census.participants.length).toBe(2);
    });

    it('should convert addresses to lowercase', () => {
      const census = new WeightedCensus();
      census.add({
        key: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        weight: '3',
      });
      
      expect(census.addresses[0]).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

    it('should update weight when adding same address twice', () => {
      const census = new WeightedCensus();
      census.add({
        key: '0x1234567890123456789012345678901234567890',
        weight: '5',
      });
      census.add({
        key: '0x1234567890123456789012345678901234567890',
        weight: '10',
      });
      
      expect(census.addresses.length).toBe(1);
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe('10');
    });

    it('should be case-insensitive when updating', () => {
      const census = new WeightedCensus();
      census.add({
        key: '0x1234567890123456789012345678901234567890',
        weight: '5',
      });
      census.add({
        key: '0x1234567890123456789012345678901234567890'.toUpperCase(),
        weight: '10',
      });
      
      expect(census.addresses.length).toBe(1);
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe('10');
    });

    it('should throw error for invalid address format', () => {
      const census = new WeightedCensus();
      expect(() => census.add({ key: 'invalid', weight: '1' })).toThrow(
        'Invalid Ethereum address format'
      );
      expect(() => census.add({ key: '0x123', weight: '1' })).toThrow(
        'Invalid Ethereum address format'
      );
    });

    it('should throw error for empty key', () => {
      const census = new WeightedCensus();
      expect(() => census.add({ key: '', weight: '1' })).toThrow('Participant key');
    });

    it('should throw error for invalid weight', () => {
      const census = new WeightedCensus();
      expect(() =>
        census.add({ key: '0x1234567890123456789012345678901234567890', weight: 'abc' })
      ).toThrow('Invalid weight format');
      expect(() =>
        census.add({ key: '0x1234567890123456789012345678901234567890', weight: '-5' })
      ).toThrow('Invalid weight format');
    });

    it('should throw error for empty string weight', () => {
      const census = new WeightedCensus();
      expect(() =>
        census.add({ key: '0x1234567890123456789012345678901234567890', weight: '' })
      ).toThrow('Invalid weight format');
    });

    it('should accept various weight values', () => {
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '100' },
        { key: '0x9876543210987654321098765432109876543210', weight: '999999999' },
      ]);
      
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe('1');
      expect(census.getWeight('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')).toBe('100');
      expect(census.getWeight('0x9876543210987654321098765432109876543210')).toBe('999999999');
    });

    it('should accept weight as number', () => {
      const census = new WeightedCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: 5 });
      
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe('5');
    });

    it('should accept weight as bigint', () => {
      const census = new WeightedCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: 100n });
      
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe('100');
    });

    it('should accept mixed weight types', () => {
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' },   // string
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 10 },    // number
        { key: '0x9876543210987654321098765432109876543210', weight: 100n }, // bigint
      ]);
      
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe('1');
      expect(census.getWeight('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')).toBe('10');
      expect(census.getWeight('0x9876543210987654321098765432109876543210')).toBe('100');
    });

    it('should handle large bigint weights', () => {
      const census = new WeightedCensus();
      const largeWeight = 99999999999999999999999n;
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: largeWeight });
      
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe(largeWeight.toString());
    });

    it('should throw error for negative number weight', () => {
      const census = new WeightedCensus();
      expect(() =>
        census.add({ key: '0x1234567890123456789012345678901234567890', weight: -5 })
      ).toThrow('Must be a positive integer');
    });

    it('should throw error for negative bigint weight', () => {
      const census = new WeightedCensus();
      expect(() =>
        census.add({ key: '0x1234567890123456789012345678901234567890', weight: -5n })
      ).toThrow('Must be a positive integer');
    });

    it('should throw error for non-integer number weight', () => {
      const census = new WeightedCensus();
      expect(() =>
        census.add({ key: '0x1234567890123456789012345678901234567890', weight: 5.5 })
      ).toThrow('Must be a positive integer');
    });

    it('should throw error for invalid string weight', () => {
      const census = new WeightedCensus();
      expect(() =>
        census.add({ key: '0x1234567890123456789012345678901234567890', weight: 'abc' })
      ).toThrow('Must be a positive integer');
    });
  });

  describe('remove', () => {
    it('should remove a participant', () => {
      const census = new WeightedCensus();
      const address = '0x1234567890123456789012345678901234567890';
      census.add({ key: address, weight: '5' });
      census.remove(address);
      
      expect(census.addresses.length).toBe(0);
      expect(census.getWeight(address)).toBeUndefined();
    });

    it('should be case-insensitive when removing', () => {
      const census = new WeightedCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: '5' });
      census.remove('0x1234567890123456789012345678901234567890'.toUpperCase());
      
      expect(census.addresses.length).toBe(0);
    });

    it('should not error when removing non-existent address', () => {
      const census = new WeightedCensus();
      expect(() => census.remove('0x1234567890123456789012345678901234567890')).not.toThrow();
    });
  });

  describe('getWeight', () => {
    it('should return weight for address', () => {
      const census = new WeightedCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: '5' });
      
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBe('5');
    });

    it('should be case-insensitive', () => {
      const census = new WeightedCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: '5' });
      
      expect(census.getWeight('0x1234567890123456789012345678901234567890'.toUpperCase())).toBe(
        '5'
      );
    });

    it('should return undefined for non-existent address', () => {
      const census = new WeightedCensus();
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBeUndefined();
    });
  });

  describe('participants', () => {
    it('should return participants with custom weights', () => {
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '1' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '10' },
      ]);
      
      const participants = census.participants;
      expect(participants).toHaveLength(2);
      
      const participant1 = participants.find(
        p => p.key === '0x1234567890123456789012345678901234567890'
      );
      const participant2 = participants.find(
        p => p.key === '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
      );
      
      expect(participant1?.weight).toBe('1');
      expect(participant2?.weight).toBe('10');
    });
  });

  describe('_setPublishedData', () => {
    it('should set published data', () => {
      const census = new WeightedCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: '5' });
      
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
