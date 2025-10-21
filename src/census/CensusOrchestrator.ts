import { VocdoniCensusService } from './CensusService';
import { Census } from './classes/Census';
import { PlainCensus } from './classes/PlainCensus';
import { WeightedCensus } from './classes/WeightedCensus';
import { CensusOrigin } from './types';

/**
 * Orchestrates census creation and publishing
 */
export class CensusOrchestrator {
  constructor(private censusService: VocdoniCensusService) {}

  /**
   * Publishes a PlainCensus or WeightedCensus
   * Creates a working census, adds participants, and publishes it
   */
  async publish(census: PlainCensus | WeightedCensus): Promise<void> {
    if (census.isPublished) {
      throw new Error('Census is already published');
    }

    if (census.participants.length === 0) {
      throw new Error('Cannot publish empty census');
    }

    // 1. Create working census
    const censusId = await this.censusService.createCensus();

    // 2. Add participants (both Plain and Weighted have .participants getter)
    await this.censusService.addParticipants(censusId, census.participants);

    // 3. Publish
    const publishResponse = await this.censusService.publishCensus(censusId);

    // 4. Update census object with published data
    census._setPublishedData(
      publishResponse.root,
      publishResponse.uri,
      publishResponse.participantCount,
      censusId
    );
  }

  /**
   * Gets census data for process creation
   * Throws if census is not published
   */
  getCensusData(census: Census): {
    type: CensusOrigin;
    root: string;
    uri: string;
    size: number;
  } {
    if (!census.isPublished) {
      throw new Error('Census must be published before creating a process');
    }

    return {
      type: census.censusOrigin,
      root: census.censusRoot!,
      uri: census.censusURI!,
      size: census.size!,
    };
  }
}
