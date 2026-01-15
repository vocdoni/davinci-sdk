import { OffchainCensus } from '../../../src/census/classes/OffchainCensus';
import { CensusOrigin } from '../../../src/census/types';

describe('OffchainCensus', () => {
  let census: OffchainCensus;

  beforeEach(() => {
    census = new OffchainCensus();
  });

  describe('Construction', () => {
    it('should create an OffchainCensus with OffchainStatic origin', () => {
      expect(census.censusOrigin).toBe(CensusOrigin.OffchainStatic);
    });

    it('should not be published initially', () => {
      expect(census.isPublished).toBe(false);
    });

    it('should require publishing', () => {
      expect(census.requiresPublishing).toBe(true);
    });

    it('should have empty participants initially', () => {
      expect(census.participants).toEqual([]);
    });
  });

  describe('Adding plain addresses', () => {
    it('should add a single address with weight 1', () => {
      census.add('0x1234567890123456789012345678901234567890');

      expect(census.participants).toHaveLength(1);
      expect(census.participants[0]).toEqual({
        key: '0x1234567890123456789012345678901234567890',
        weight: '1',
      });
    });

    it('should add multiple addresses with weight 1', () => {
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ]);

      expect(census.participants).toHaveLength(2);
      expect(census.participants[0].weight).toBe('1');
      expect(census.participants[1].weight).toBe('1');
    });

    it('should normalize addresses to lowercase', () => {
      census.add('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');

      expect(census.participants[0].key).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });
  });

  describe('Adding weighted participants', () => {
    it('should add a single weighted participant', () => {
      census.add({
        key: '0x1234567890123456789012345678901234567890',
        weight: 100,
      });

      expect(census.participants).toHaveLength(1);
      expect(census.participants[0].weight).toBe('100');
    });

    it('should add multiple weighted participants', () => {
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: 100 },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 50 },
      ]);

      expect(census.participants).toHaveLength(2);
      expect(census.participants[0].weight).toBe('100');
      expect(census.participants[1].weight).toBe('50');
    });

    it('should accept weight as string', () => {
      census.add({
        key: '0x1234567890123456789012345678901234567890',
        weight: '500',
      });

      expect(census.participants[0].weight).toBe('500');
    });

    it('should accept weight as bigint', () => {
      census.add({
        key: '0x1234567890123456789012345678901234567890',
        weight: 1000n,
      });

      expect(census.participants[0].weight).toBe('1000');
    });
  });

  describe('Mixed usage', () => {
    it('should handle mixing plain and weighted participants', () => {
      census.add('0x1111111111111111111111111111111111111111');
      census.add({ key: '0x2222222222222222222222222222222222222222', weight: 50 });
      census.add(['0x3333333333333333333333333333333333333333']);

      expect(census.participants).toHaveLength(3);
      expect(census.participants[0].weight).toBe('1');
      expect(census.participants[1].weight).toBe('50');
      expect(census.participants[2].weight).toBe('1');
    });
  });

  describe('Removing participants', () => {
    it('should remove a participant by address', () => {
      const address = '0x1234567890123456789012345678901234567890';
      census.add(address);
      census.remove(address);

      expect(census.participants).toHaveLength(0);
    });

    it('should handle case-insensitive removal', () => {
      census.add('0xabcdef1234567890abcdef1234567890abcdef12');
      census.remove('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');

      expect(census.participants).toHaveLength(0);
    });
  });

  describe('Getting weights', () => {
    it('should return weight for existing address', () => {
      const address = '0x1234567890123456789012345678901234567890';
      census.add({ key: address, weight: 100 });

      expect(census.getWeight(address)).toBe('100');
    });

    it('should return undefined for non-existent address', () => {
      expect(census.getWeight('0x1234567890123456789012345678901234567890')).toBeUndefined();
    });
  });

  describe('Validation', () => {
    it('should reject invalid address format', () => {
      expect(() => census.add('invalid')).toThrow('Invalid Ethereum address format');
    });

    it('should reject invalid weight format', () => {
      expect(() =>
        census.add({
          key: '0x1234567890123456789012345678901234567890',
          weight: 'abc',
        } as any)
      ).toThrow('Invalid weight format');
    });

    it('should reject negative weight', () => {
      expect(() =>
        census.add({
          key: '0x1234567890123456789012345678901234567890',
          weight: -10,
        })
      ).toThrow('Invalid weight');
    });
  });

  describe('Addresses getter', () => {
    it('should return all participant addresses', () => {
      census.add([
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
      ]);

      const addresses = census.addresses;
      expect(addresses).toHaveLength(2);
      expect(addresses).toContain('0x1111111111111111111111111111111111111111');
      expect(addresses).toContain('0x2222222222222222222222222222222222222222');
    });
  });

  describe('Publishing state', () => {
    it('should update state after _setPublishedData', () => {
      census.add('0x1234567890123456789012345678901234567890');
      
      census._setPublishedData(
        '0xabcdef1234567890',
        'ipfs://QmTest',
        'census123'
      );

      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBe('0xabcdef1234567890');
      expect(census.censusURI).toBe('ipfs://QmTest');
      expect(census.censusId).toBe('census123');
    });

    it('should handle _setPublishedData without censusId', () => {
      census.add('0x1234567890123456789012345678901234567890');
      
      census._setPublishedData('0xabcdef1234567890', 'ipfs://QmTest');

      expect(census.isPublished).toBe(true);
      expect(census.censusId).toBeNull();
    });
  });
});
