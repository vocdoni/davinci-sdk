import { OffchainDynamicCensus } from '../../../src/census/classes/OffchainDynamicCensus';
import { CensusOrigin } from '../../../src/census/types';

describe('OffchainDynamicCensus', () => {
  let census: OffchainDynamicCensus;

  beforeEach(() => {
    census = new OffchainDynamicCensus();
  });

  describe('Construction', () => {
    it('should create an OffchainDynamicCensus with OffchainDynamic origin', () => {
      expect(census.censusOrigin).toBe(CensusOrigin.OffchainDynamic);
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
  });

  describe('Differences from OffchainCensus', () => {
    it('should have OffchainDynamic census origin', () => {
      expect(census.censusOrigin).toBe(CensusOrigin.OffchainDynamic);
      expect(census.censusOrigin).not.toBe(CensusOrigin.OffchainStatic);
    });

    it('should still require publishing like OffchainCensus', () => {
      expect(census.requiresPublishing).toBe(true);
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
  });
});
