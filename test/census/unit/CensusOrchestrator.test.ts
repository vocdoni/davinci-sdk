import { CensusOrchestrator } from '../../../src/census/CensusOrchestrator';
import { PlainCensus, WeightedCensus, CspCensus } from '../../../src/census/classes';
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

  describe('publish - PlainCensus', () => {
    it('should publish a plain census', async () => {
      const census = new PlainCensus();
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
      expect(census.size).toBe(2);
      expect(census.censusId).toBe('census-id-123');
    });

    it('should throw error if census is already published', async () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      census._setPublishedData('0xroot', 'ipfs://uri', 1, 'census-id');

      await expect(orchestrator.publish(census)).rejects.toThrow(
        'Census is already published'
      );

      expect(mockCensusService.createCensus).not.toHaveBeenCalled();
    });

    it('should throw error if census is empty', async () => {
      const census = new PlainCensus();

      await expect(orchestrator.publish(census)).rejects.toThrow('Cannot publish empty census');

      expect(mockCensusService.createCensus).not.toHaveBeenCalled();
    });
  });

  describe('publish - WeightedCensus', () => {
    it('should publish a weighted census', async () => {
      const census = new WeightedCensus();
      census.add([
        { key: '0x1234567890123456789012345678901234567890', weight: '5' },
        { key: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', weight: '10' },
      ]);

      mockCensusService.createCensus.mockResolvedValue('census-id-456');
      mockCensusService.addParticipants.mockResolvedValue(undefined);
      mockCensusService.publishCensus.mockResolvedValue({
        root: '0xroot456',
        participantCount: 2,
        createdAt: '2024-01-01T00:00:00Z',
        publishedAt: '2024-01-01T00:01:00Z',
        uri: 'ipfs://published-uri',
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
      expect(census.size).toBe(2);
      expect(census.censusId).toBe('census-id-456');
    });
  });

  describe('getCensusData', () => {
    it('should get census data from plain census', () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');
      census._setPublishedData('0xroot123', 'ipfs://uri123', 1);

      const data = orchestrator.getCensusData(census);

      expect(data).toEqual({
        type: CensusOrigin.CensusOriginMerkleTree,
        root: '0xroot123',
        uri: 'ipfs://uri123',
        size: 1,
      });
    });

    it('should get census data from weighted census', () => {
      const census = new WeightedCensus();
      census.add({ key: '0x1234567890123456789012345678901234567890', weight: '5' });
      census._setPublishedData('0xroot456', 'ipfs://uri456', 1);

      const data = orchestrator.getCensusData(census);

      expect(data).toEqual({
        type: CensusOrigin.CensusOriginMerkleTree,
        root: '0xroot456',
        uri: 'ipfs://uri456',
        size: 1,
      });
    });

    it('should get census data from CSP census', () => {
      const census = new CspCensus('0x1234567890abcdef', 'https://csp-server.com', 100);

      const data = orchestrator.getCensusData(census);

      expect(data).toEqual({
        type: CensusOrigin.CensusOriginCSP,
        root: '0x1234567890abcdef',
        uri: 'https://csp-server.com',
        size: 100,
      });
    });

    it('should throw error if census is not published', () => {
      const census = new PlainCensus();
      census.add('0x1234567890123456789012345678901234567890');

      expect(() => orchestrator.getCensusData(census)).toThrow(
        'Census must be published before creating a process'
      );
    });
  });
});
