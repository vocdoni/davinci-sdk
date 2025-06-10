import {BaseService} from "./BaseService";
import {
    CensusParticipant,
    CensusProof,
    CreateProcessRequest,
    CreateProcessResponse,
    GetProcessResponse,
    InfoResponse,
    VoteRequest, 
    VoteStatusResponse,
} from "./types";
import { ElectionMetadata } from "../../core";

function isUUId(str: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

function isHexString(str: string): boolean {
    return /^0x[0-9a-f]{64}$/i.test(str);
}

export class VocdoniApiService extends BaseService {
    constructor(baseURL: string) {
        super(baseURL);
    }

    async ping(): Promise<void> {
        await this.request({ method: "GET", url: "/ping" });
    }

    createProcess(body: CreateProcessRequest): Promise<CreateProcessResponse> {
        return this.request({
            method: "POST",
            url: "/processes",
            data: body
        });
    }

    getProcess(processId: string): Promise<GetProcessResponse> {
        return this.request({
            method: "GET",
            url: `/processes/${processId}`
        });
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

    getCensusSize(censusId: string): Promise<number> {
        if (!isUUId(censusId)) throw new Error("Invalid census ID format");

        return this.request<{ size: number }>({
            method: "GET",
            url: `/censuses/${censusId}/size`
        }).then(res => res.size);
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

    submitVote(vote: VoteRequest): Promise<string> {
        return this.request<{ voteId: string }>({
            method: "POST",
            url: "/votes",
            data: vote,
        }).then(res => res.voteId);
    }

    getVoteStatus(
        processId: string,
        voteId: string
    ): Promise<VoteStatusResponse> {
        return this.request<VoteStatusResponse>({
            method: "GET",
            url: `/votes/status/${processId}/${voteId}`,
        });
    }

    getInfo(): Promise<InfoResponse> {
        return this.request<InfoResponse>({
            method: "GET",
            url: "/info"
        });
    }

    pushMetadata(metadata: ElectionMetadata): Promise<string> {
        return this.request<{ hash: string }>({
            method: "POST",
            url: "/metadata",
            data: metadata
        }).then(res => res.hash);
    }

    getMetadata(hash: string): Promise<ElectionMetadata> {
        if (!isHexString(hash)) throw new Error("Invalid metadata hash format");

        return this.request<ElectionMetadata>({
            method: "GET",
            url: `/metadata/${hash}`
        });
    }

    getMetadataUrl(hash: string): string {
        if (!isHexString(hash)) throw new Error("Invalid metadata hash format");
        return `${this.axios.defaults.baseURL}/metadata/${hash}`;
    }
}
