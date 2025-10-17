import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { VocdoniCensusService } from '../../../src/census';
import { CensusParticipant, CensusOrigin } from '../../../src/census/types';
import {
  generateMockCensusParticipants,
  isValidUUID,
  isValidHex,
} from '../../sequencer/integration/utils';

const censusService = new VocdoniCensusService(process.env.CENSUS_API_URL!);
let workingCensusId: string;
let publishedCensusRoot: string;

// Generate test participants
const testParticipants = generateMockCensusParticipants(5);

describe('VocdoniCensusService Integration', () => {
  describe('Working Census Operations', () => {
    it('should create a new working census and return a valid UUID', async () => {
      workingCensusId = await censusService.createCensus();
      expect(typeof workingCensusId).toBe('string');
      expect(isValidUUID(workingCensusId)).toBe(true);
    });

    it('should add participants to the working census', async () => {
      await expect(
        censusService.addParticipants(workingCensusId, testParticipants)
      ).resolves.toBeUndefined();
    });

    it.skip('should retrieve the census participants from working census', async () => {
      // Skip: This endpoint is not yet implemented for working censuses
      const participants = await censusService.getParticipants(workingCensusId);

      expect(Array.isArray(participants)).toBe(true);
      expect(participants.length).toBe(testParticipants.length);

      // Create a lookup map from the response
      const responseMap = new Map(
        participants.map((p: CensusParticipant) => [p.key.toLowerCase(), p.weight])
      );

      // Assert each expected participant exists with the correct weight
      for (const expected of testParticipants) {
        const actualWeight = responseMap.get(expected.key.toLowerCase());
        expect(actualWeight).toBeDefined();
        expect(actualWeight).toBe(expected.weight);
      }
    });

    it('should fetch the census root from working census', async () => {
      const root = await censusService.getCensusRoot(workingCensusId);
      expect(typeof root).toBe('string');
      expect(isValidHex(root, 64)).toBe(true);
    });

    it('should fetch the census size from working census', async () => {
      const size = await censusService.getCensusSizeById(workingCensusId);
      expect(typeof size).toBe('number');
      expect(size).toBe(testParticipants.length);
    });

    it('should fetch the census size using generic method with UUID', async () => {
      const size = await censusService.getCensusSize(workingCensusId);
      expect(typeof size).toBe('number');
      expect(size).toBe(testParticipants.length);
    });
  });

  describe('Census Publishing', () => {
    it('should publish the working census and return publish response', async () => {
      const publishResponse = await censusService.publishCensus(workingCensusId);

      expect(typeof publishResponse.root).toBe('string');
      expect(isValidHex(publishResponse.root, 64)).toBe(true);
      expect(typeof publishResponse.participantCount).toBe('number');
      expect(publishResponse.participantCount).toBe(testParticipants.length);
      expect(typeof publishResponse.createdAt).toBe('string');
      expect(typeof publishResponse.publishedAt).toBe('string');

      // Validate ISO timestamp format
      expect(new Date(publishResponse.createdAt).toString()).not.toBe('Invalid Date');
      expect(new Date(publishResponse.publishedAt).toString()).not.toBe('Invalid Date');

      publishedCensusRoot = publishResponse.root;
    });

    it('should be able to get proofs from published census using root', async () => {
      const proof = await censusService.getCensusProof(
        publishedCensusRoot,
        testParticipants[0].key
      );
      expect(proof).toHaveProperty('root');
      expect(proof).toHaveProperty('address');
      expect(proof).toHaveProperty('weight');
      expect(proof).toHaveProperty('censusOrigin');
      expect(proof.root).toBe(publishedCensusRoot);

      // Check that it's either a Merkle or CSP proof
      if (proof.censusOrigin === CensusOrigin.CensusOriginMerkleTree) {
        // Merkle proof should have value and siblings
        expect(proof).toHaveProperty('value');
        expect(proof).toHaveProperty('siblings');
      } else if (proof.censusOrigin === CensusOrigin.CensusOriginCSP) {
        // CSP proof should have processId, publicKey, and signature
        expect(proof).toHaveProperty('processId');
        expect(proof).toHaveProperty('publicKey');
        expect(proof).toHaveProperty('signature');
      }
    });

    it('should get census size by root for published census', async () => {
      const size = await censusService.getCensusSizeByRoot(publishedCensusRoot);
      expect(typeof size).toBe('number');
      expect(size).toBe(testParticipants.length);
    });

    it('should get census size using generic method with root', async () => {
      const size = await censusService.getCensusSize(publishedCensusRoot);
      expect(typeof size).toBe('number');
      expect(size).toBe(testParticipants.length);
    });
  });

  describe('Published Census Restrictions', () => {
    it('should not allow adding participants to published census (using root)', async () => {
      // Published censuses are identified by root, not UUID, so this should fail
      await expect(
        censusService.addParticipants(publishedCensusRoot, testParticipants)
      ).rejects.toThrow('Invalid census ID format');
    });

    it('should not allow deleting published census (using root)', async () => {
      // Published censuses are identified by root, not UUID, so this should fail
      await expect(censusService.deleteCensus(publishedCensusRoot)).rejects.toThrow(
        'Invalid census ID format'
      );
    });
  });

  describe('BigQuery Endpoints', () => {
    it('should get health status', async () => {
      const health = await censusService.getHealth();
      expect(typeof health.status).toBe('string');
      expect(typeof health.timestamp).toBe('string');
      expect(typeof health.service).toBe('string');

      // Validate ISO timestamp format
      expect(new Date(health.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('should get snapshots with default parameters', async () => {
      const snapshots = await censusService.getSnapshots();
      expect(Array.isArray(snapshots.snapshots)).toBe(true);
      expect(typeof snapshots.total).toBe('number');
      expect(typeof snapshots.page).toBe('number');
      expect(typeof snapshots.pageSize).toBe('number');
      expect(typeof snapshots.hasNext).toBe('boolean');
      expect(typeof snapshots.hasPrev).toBe('boolean');
    });

    it('should get snapshots with custom parameters', async () => {
      const snapshots = await censusService.getSnapshots({
        page: 1,
        pageSize: 5,
        minBalance: 1.0,
      });
      expect(Array.isArray(snapshots.snapshots)).toBe(true);
      expect(snapshots.page).toBe(1);
      expect(snapshots.pageSize).toBe(5);
    });

    it('should get latest snapshot', async () => {
      const snapshot = await censusService.getLatestSnapshot();

      // Required fields based on actual API response
      expect(typeof snapshot.snapshotDate).toBe('string');
      expect(typeof snapshot.censusRoot).toBe('string');
      expect(typeof snapshot.participantCount).toBe('number');
      expect(typeof snapshot.minBalance).toBe('number');
      expect(typeof snapshot.queryName).toBe('string');
      expect(typeof snapshot.createdAt).toBe('string');

      // Validate ISO timestamp formats
      expect(new Date(snapshot.snapshotDate).toString()).not.toBe('Invalid Date');
      expect(new Date(snapshot.createdAt).toString()).not.toBe('Invalid Date');

      // Optional fields - test if present
      if (snapshot.queryType !== undefined) {
        expect(typeof snapshot.queryType).toBe('string');
      }
      if (snapshot.decimals !== undefined) {
        expect(typeof snapshot.decimals).toBe('number');
      }
      if (snapshot.period !== undefined) {
        expect(typeof snapshot.period).toBe('string');
      }
      if (snapshot.parameters !== undefined) {
        expect(typeof snapshot.parameters).toBe('object');
      }
      if (snapshot.weightConfig !== undefined) {
        expect(typeof snapshot.weightConfig).toBe('object');
        expect(typeof snapshot.weightConfig.strategy).toBe('string');
        expect(typeof snapshot.weightConfig.targetMinWeight).toBe('number');
        expect(typeof snapshot.weightConfig.maxWeight).toBe('number');
      }
    });
  });

  describe('Cleanup', () => {
    it('should delete the working census', async () => {
      await expect(censusService.deleteCensus(workingCensusId)).resolves.toBeUndefined();
    });
  });
});
