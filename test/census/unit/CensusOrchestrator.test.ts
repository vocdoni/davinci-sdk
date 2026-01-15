import { CensusOrchestrator } from '../../../src/census/CensusOrchestrator';
import { OffchainCensus, OffchainDynamicCensus, CspCensus, OnchainCensus } from '../../../src/census/classes';
import { CensusOrigin } from '../../../src/census/types';
import type { VocdoniCensusService } from '../../../src/census/CensusService';

describe('CensusOrchestrator', () => {
  let mockCensusService: jest.Mocked<VocdoniCensusService>;
  let orchestrator: CensusOrchestrator;

  beforeEach(() => {
    mockCensusService = {
      createCensus: jest.fn(),
      addParticipants: jest.fn(),
      publishCensus: jest.fn(),
    } as any;

    orchestrator = new CensusOrchestrator(mockCensusService);
  });

  describe('publish - OffchainCensus', () => {
    it('should publish an offchain census with plain addresses', async () => {
      const census = new OffchainCensus();
      census.add([
        '0x1234567890123456789012345678901234567890',
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ]);

      mockCensusService.createCensus.mockResolvedValue('census-id-123');
      mockCensusService.addParticipants.mockResolvedValue(undefined);
      mockCensusService.publishCensus.mockResolvedValue({
        root: '0xroot123',
        participantCount: 2,
        createdAt: '2024-01-01T00:00:00Z',
        publishedAt: '2024-01-01T00:01:00Z',
        uri: 'ipfs://published-uri',
        size: 2,
      });

      await orchestrator.publish(census);

      expect(mockCensusService.createCensus).toHaveBeenCalledTimes(1);
      expect(mockCensusService.addParticipants).toHaveBeenCalledWith('census-id-123', [
        { key: '0x1234567890123456789012345678901234567890', weight: '1' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '1' },
      ]);
      expect(mockCensusService.publishCensus).toHaveBeenCalledWith('census-id-123');

      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBe('0xroot123');
      expect(census.censusURI).toBe('ipfs://published-uri');
      expect(census.censusId).toBe('census-id-123');
    });

    it('should publish an offchain census with weighted participants', async () => {
      const census = new OffchainCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: 5 },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 10 },
      ]);

      mockCensusService.createCensus.mockResolvedValue('census-id-456');
      mockCensusService.addParticipants.mockResolvedValue(undefined);
      mockCensusService.publishCensus.mockResolvedValue({
        root: '0xroot456',
        participantCount: 2,
        createdAt: '2024-01-01T00:00:00Z',
        publishedAt: '2024-01-01T00:01:00Z',
        uri: 'ipfs://published-uri',
        size: 2,
      });

      await orchestrator.publish(census);

      expect(mockCensusService.createCensus).toHaveBeenCalledTimes(1);
      expect(mockCensusService.addParticipants).toHaveBeenCalledWith('census-id-456', [
        { key: '0x1234567890123456789012345678901234567890', weight: '5' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '10' },
      ]);
      expect(mockCensusService.publishCensus).toHaveBeenCalledWith('census-id-456');

      expect(census.isPublished).toBe(true);
      expect(census.censusRoot).toBe('0xroot456');
      expect(census.censusURI).toBe('ipfs://published-uri');
      expect(census.censusId).toBe('census-id-456');
    });

    it('should throw error if census is already published', async () => {
      const census = new OffchainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      census._setPublishedData('0xroot', 'ipfs://uri', 'census-id');

      await expect(orchestrator.publish(census)).rejects.toThrow(
        'Census is already published'
      );

      expect(mockCensusService.createCensus).not.toHaveBeenCalled();
    });

    it('should throw error if census is empty', async () => {
      const census = new OffchainCensus();

      await expect(orchestrator.publish(census)).rejects.toThrow('Cannot publish empty census');

      expect(mockCensusService.createCensus).not.toHaveBeenCalled();
    });
  });

  describe('publish - OffchainDynamicCensus', () => {
    it('should publish an offchain dynamic census', async () => {
      const census = new OffchainDynamicCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: 3 },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: 7 },
      ]);

      mockCensusService.createCensus.mockResolvedValue('census-id-789');
      mockCensusService.addParticipants.mockResolvedValue(undefined);
      mockCensusService.publishCensus.mockResolvedValue({
        root: '0xroot789',
        participantCount: 2,
        createdAt: '2024-01-01T00:00:00Z',
        publishedAt: '2024-01-01T00:01:00Z',
        uri: 'ipfs://published-uri',
        size: 2,
      });

      await orchestrator.publish(census);

      expect(census.isPublished).toBe(true);
      expect(census.censusOrigin).toBe(CensusOrigin.OffchainDynamic);
    });
  });

  describe('getCensusData', () => {
    it('should get census data from published OffchainCensus', () => {
      const census = new OffchainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      census._setPublishedData('0xroot123', 'ipfs://uri123');

      const data = orchestrator.getCensusData(census);

      expect(data).toEqual({
        type: CensusOrigin.OffchainStatic,
        root: '0xroot123',
        uri: 'ipfs://uri123',
      });
    });

    it('should get census data from published OffchainDynamicCensus', () => {
      const census = new OffchainDynamicCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: 5 });
      census._setPublishedData('0xroot456', 'ipfs://uri456');

      const data = orchestrator.getCensusData(census);

      expect(data).toEqual({
        type: CensusOrigin.OffchainDynamic,
        root: '0xroot456',
        uri: 'ipfs://uri456',
      });
    });

    it('should get census data from OnchainCensus (no publishing needed)', () => {
      const contractAddress = '0x1234567890123456789012345678901234567890';
      const census = new OnchainCensus(contractAddress);

      const data = orchestrator.getCensusData(census);

      expect(data).toEqual({
        type: CensusOrigin.Onchain,
        root: contractAddress,
        uri: `contract://${contractAddress}`,
      });
    });

    it('should get census data from CspCensus (no publishing needed)', () => {
      const publicKey = '0x1234567890abcdef';
      const cspURI = 'https://csp-server.com';
      const census = new CspCensus(publicKey, cspURI);

      const data = orchestrator.getCensusData(census);

      expect(data).toEqual({
        type: CensusOrigin.CSP,
        root: publicKey,
        uri: cspURI,
      });
    });

    it('should throw error if Merkle census is not published', () => {
      const census = new OffchainCensus();
      census.add('0x1234567890123456789012345678901234567890');

      expect(() => orchestrator.getCensusData(census)).toThrow(
        'Merkle census must be published before creating a process'
      );
    });

    it('should NOT throw error for OnchainCensus even if not "published"', () => {
      const census = new OnchainCensus('0x1234567890123456789012345678901234567890');
      
      // OnchainCensus is always ready, no publishing needed
      expect(() => orchestrator.getCensusData(census)).not.toThrow();
    });

    it('should NOT throw error for CspCensus even if not "published"', () => {
      const census = new CspCensus('0x1234567890abcdef', 'https://csp-server.com');
      
      // CspCensus is always ready, no publishing needed
      expect(() => orchestrator.getCensusData(census)).not.toThrow();
    });
  });

  describe('requiresPublishing', () => {
    it('should identify which censuses require publishing', () => {
      const offchain = new OffchainCensus();
      const offchainDynamic = new OffchainDynamicCensus();
      const onchain = new OnchainCensus('0x1234567890123456789012345678901234567890');
      const csp = new CspCensus('0xabcdef', 'https://csp.com');

      expect(offchain.requiresPublishing).toBe(true);
      expect(offchainDynamic.requiresPublishing).toBe(true);
      expect(onchain.requiresPublishing).toBe(false);
      expect(csp.requiresPublishing).toBe(false);
    });
  });
});
