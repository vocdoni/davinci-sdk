import { VocdoniCensusService } from '../../census';
import { VocdoniSequencerService } from '../../sequencer/SequencerService';
import type { BaseServiceConfig } from './BaseService';

export interface VocdoniApiServiceConfig {
  sequencerURL: string;
  censusURL: string;
  /** Headers, `fetchImpl`, timeout and body cap of the sequencer client. */
  sequencerConfig?: BaseServiceConfig;
}

export class VocdoniApiService {
  public readonly census: VocdoniCensusService;
  public readonly sequencer: VocdoniSequencerService;

  constructor(config: VocdoniApiServiceConfig) {
    this.sequencer = new VocdoniSequencerService(config.sequencerURL, config.sequencerConfig);
    this.census = new VocdoniCensusService(config.censusURL);
  }
}
