import {BaseService} from "./BaseService";
import {
    CensusParticipant,
    CensusProof,
    CreateProcessRequest,
    CreateProcessResponse,
    GetProcessResponse,
    InfoResponse,
    VoteRequest, VoteStatusResponse,
} from "./types";

function isUUId(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

export class VocdoniApiService extends BaseService {
    constructor(baseURL: string) {
        super(baseURL);
    }

    async ping(): Promise<void> {
        await this.request({ method: "GET", url: "/ping" });
    }

    async createProcess(body: CreateProcessRequest): Promise<CreateProcessResponse> {
        return this.request({
            method: "POST",
            url: "/processes",
            data: body
        });
    }

    async getProcess(processId: string): Promise<GetProcessResponse> {
        return this.request({
            method: "GET",
            url: `/processes/${processId}`
        });
    }

    async createCensus(): Promise<string> {
        const res = await this.request<{ census: string }>({
            method: "POST",
            url: "/censuses"
        });
        return res.census;
    }

    async addParticipants(censusId: string, participants: CensusParticipant[]): Promise<void> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        await this.request({
            method: "POST",
            url: `/censuses/${censusId}/participants`,
            data: { participants }
        });
    }

    async getParticipants(censusId: string): Promise<CensusParticipant[]> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        const res = await this.request<{ participants: CensusParticipant[] }>({
            method: "GET",
            url: `/censuses/${censusId}/participants`
        });
        return res.participants;
    }

    async getCensusRoot(censusId: string): Promise<string> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        const res = await this.request<{ root: string }>({
            method: "GET",
            url: `/censuses/${censusId}/root`
        });
        return res.root;
    }

    async getCensusSize(censusId: string): Promise<number> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        const res = await this.request<{ size: number }>({
            method: "GET",
            url: `/censuses/${censusId}/size`
        });
        return res.size;
    }

    async deleteCensus(censusId: string): Promise<void> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        await this.request({
            method: "DELETE",
            url: `/censuses/${censusId}`
        });
    }

    async getCensusProof(censusRoot: string, key: string): Promise<CensusProof> {
        return await this.request<CensusProof>({
            method: "GET",
            url: `/censuses/${censusRoot}/proof`,
            params: {key}
        });
    }

    async submitVote(vote: VoteRequest): Promise<string> {
        const { voteId } = await this.request<{ voteId: string }>({
            method: "POST",
            url: "/votes",
            data: vote,
        });
        return voteId;
    }

    async getVoteStatus(
        processId: string,
        voteId: string
    ): Promise<VoteStatusResponse> {
        return this.request<VoteStatusResponse>({
            method: "GET",
            url: `/votes/status/${processId}/${voteId}`,
        });
    }

    async getInfo(): Promise<InfoResponse> {
        return this.request<InfoResponse>({
            method: "GET",
            url: "/info"
        });
    }
}
