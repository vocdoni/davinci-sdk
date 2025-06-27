import {BaseService} from "./BaseService";
import {
    CensusParticipant,
    CensusProof,
    CreateProcessRequest,
    CreateProcessResponse,
    GetProcessResponse,
    InfoResponse,
    ListProcessesResponse,
    SequencerStats,
    VoteBallot,
    VoteRequest, 
    VoteStatusResponse,
    WorkersResponse,
} from "./types";
import { validateProcessId } from "./helpers";
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
        // Validate processId format
        if (!validateProcessId(body.processId)) {
            throw new Error("Invalid processId format. Must be a 64-character hex string (32 bytes)");
        }

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

    listProcesses(): Promise<string[]> {
        return this.request<ListProcessesResponse>({
            method: "GET",
            url: "/processes"
        }).then(res => res.processes);
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
            url: `/votes/${processId}/voteId/${voteId}`,
        });
    }

    getVoteByNullifier(
        processId: string,
        nullifier: string
    ): Promise<VoteBallot> {
        return this.request<VoteBallot>({
            method: "GET",
            url: `/votes/${processId}/nullifier/${nullifier}`,
        });
    }

    async hasAddressVoted(
        processId: string,
        address: string
    ): Promise<boolean> {
        try {
            await this.request({
                method: "GET",
                url: `/votes/${processId}/address/${address}`,
            });
            return true;
        } catch (error: any) {
            if (error?.code === 40001) {
                return false;
            }
            throw error;
        }
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

    getStats(): Promise<SequencerStats> {
        return this.request<SequencerStats>({
            method: "GET",
            url: "/sequencer/stats"
        });
    }

    getWorkers(): Promise<WorkersResponse> {
        return this.request<WorkersResponse>({
            method: "GET",
            url: "/sequencer/workers"
        });
    }
}
