import { VocdoniCensusService } from "../../census";
import { VocdoniSequencerService } from "../../sequencer/SequencerService";

export interface VocdoniApiServiceConfig {
    sequencerURL: string;
    censusURL: string;
}

export class VocdoniApiService {
    public readonly census: VocdoniCensusService;
    public readonly sequencer: VocdoniSequencerService;

    constructor(config: VocdoniApiServiceConfig) {
        this.sequencer = new VocdoniSequencerService(config.sequencerURL);
        this.census = new VocdoniCensusService(config.censusURL);
    }
}
