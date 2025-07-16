import { VocdoniCensusService } from "../../census";
import { VocdoniSequencerService } from "../../sequencer/SequencerService";

export interface VocdoniApiServiceConfig {
    sequencerURL?: string;
    censusURL?: string;
}

export class VocdoniApiService {
    public readonly census?: VocdoniCensusService;
    public readonly sequencer?: VocdoniSequencerService;

    constructor(config: VocdoniApiServiceConfig) {
        if (config.sequencerURL) {
            this.sequencer = new VocdoniSequencerService(config.sequencerURL);
        }
        if (config.censusURL) {
            this.census = new VocdoniCensusService(config.censusURL);
        }
    }
}
