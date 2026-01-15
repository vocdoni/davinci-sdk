import { VocdoniCensusService } from './CensusService';
import { Census } from './classes/Census';
import { MerkleCensus } from './classes/MerkleCensus';
import { CensusOrigin } from './types';

/**
 * Orchestrates census creation and publishing
 */
export class CensusOrchestrator {
  constructor(private censusService: VocdoniCensusService) {}

  /**
   * Publishes a MerkleCensus (OffchainCensus, OffchainDynamicCensus, or OnchainCensus)
   * Creates a working census, adds participants, and publishes it
   */
  async publish(census: MerkleCensus): Promise<void> {
    if (census.isPublished) {
      throw new Error('Census is already published');
    }

    if (census.participants.length === 0) {
      throw new Error('Cannot publish empty census');
    }

    // 1. Create working census
    const censusId = await this.censusService.createCensus();

    // 2. Add participants
    await this.censusService.addParticipants(censusId, census.participants);

    // 3. Publish
    const publishResponse = await this.censusService.publishCensus(censusId);

    // 4. Update census object with published data
    census._setPublishedData(
      publishResponse.root,
      publishResponse.uri,
      censusId
    );
  }

  /**
   * Gets census data for process creation
   * Throws if census is not ready (published for Merkle/CSP, or constructed for Onchain)
   */
  getCensusData(census: Census): {
    type: CensusOrigin;
    root: string;
    uri: string;
  } {
    // Only Merkle censuses (OffchainStatic, OffchainDynamic) need to be published
    // Onchain and CSP censuses are ready immediately upon construction
    if (census.requiresPublishing && !census.isPublished) {
      throw new Error('Merkle census must be published before creating a process');
    }

    if (!census.censusRoot || !census.censusURI) {
      throw new Error('Census data is incomplete');
    }

    return {
      type: census.censusOrigin,
      root: census.censusRoot,
      uri: census.censusURI,
    };
  }
}
