import { BaseService } from "../core/api/BaseService";
import { 
    CensusParticipant, 
    CensusProof, 
    PublishCensusResponse, 
    SnapshotsResponse, 
    SnapshotsQueryParams, 
    Snapshot, 
    CensusSizeResponse, 
    HealthResponse 
} from "./types";

function isUUId(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

export class VocdoniCensusService extends BaseService {
    constructor(baseURL: string) {
        super(baseURL);
    }

    /**
     * Constructs the URI for accessing a census by its root
     * @param censusRoot - The census root (hex-prefixed)
     * @returns The constructed URI for the census
     */
    getCensusUri(censusRoot: string): string {
        return `${this.axios.defaults.baseURL}/censuses/${censusRoot}`;
    }

    createCensus(): Promise<string> {
        return this.request<{ census: string }>({
            method: "POST",
            url: "/censuses"
        }).then(res => res.census);
    }

    async addParticipants(censusId: string, participants: CensusParticipant[]): Promise<void> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        await this.request({
            method: "POST",
            url: `/censuses/${censusId}/participants`,
            data: { participants }
        });
    }

    getParticipants(censusId: string): Promise<CensusParticipant[]> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        return this.request<{ participants: CensusParticipant[] }>({
            method: "GET",
            url: `/censuses/${censusId}/participants`
        }).then(res => res.participants);
    }

    getCensusRoot(censusId: string): Promise<string> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        return this.request<{ root: string }>({
            method: "GET",
            url: `/censuses/${censusId}/root`
        }).then(res => res.root);
    }

    getCensusSizeById(censusId: string): Promise<number> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        return this.request<{ size: number }>({
            method: "GET",
            url: `/censuses/${censusId}/size`
        }).then(res => res.size);
    }

    getCensusSizeByRoot(censusRoot: string): Promise<number> {
        return this.request<CensusSizeResponse>({
            method: "GET",
            url: `/censuses/${censusRoot}/size`
        }).then(res => res.size);
    }

    getCensusSize(censusIdOrRoot: string): Promise<number> {
        if (isUUId(censusIdOrRoot)) {
            return this.getCensusSizeById(censusIdOrRoot);
        } else {
            return this.getCensusSizeByRoot(censusIdOrRoot);
        }
    }

    async deleteCensus(censusId: string): Promise<void> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        await this.request({
            method: "DELETE",
            url: `/censuses/${censusId}`
        });
    }

    getCensusProof(censusRoot: string, key: string): Promise<CensusProof> {
        return this.request<CensusProof>({
            method: "GET",
            url: `/censuses/${censusRoot}/proof`,
            params: {key}
        });
    }

    publishCensus(censusId: string): Promise<PublishCensusResponse> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        return this.request<Omit<PublishCensusResponse, 'uri'>>({
            method: "POST",
            url: `/censuses/${censusId}/publish`
        }).then(response => ({
            ...response,
            uri: this.getCensusUri(response.root)
        }));
    }

    // BigQuery endpoints

    getSnapshots(params?: SnapshotsQueryParams): Promise<SnapshotsResponse> {
        return this.request<SnapshotsResponse>({
            method: "GET",
            url: "/snapshots",
            params
        });
    }

    getLatestSnapshot(): Promise<Snapshot> {
        return this.request<Snapshot>({
            method: "GET",
            url: "/snapshots/latest"
        });
    }

    getHealth(): Promise<HealthResponse> {
        return this.request<HealthResponse>({
            method: "GET",
            url: "/health"
        });
    }
}
