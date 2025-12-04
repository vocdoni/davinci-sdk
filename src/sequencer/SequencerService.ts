import { BaseService } from '../core/api/BaseService';
import {
  CreateProcessRequest,
  CreateProcessResponse,
  GetProcessResponse,
  InfoResponse,
  ListProcessesResponse,
  ParticipantInfoResponse,
  SequencerStats,
  VoteBallot,
  VoteRequest,
  VoteStatusResponse,
  WorkersResponse,
} from './api/types';
import { validateProcessId } from './api/helpers';
import { ElectionMetadata } from '../core';

function isHexString(str: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(str);
}

export class VocdoniSequencerService extends BaseService {
  constructor(baseURL: string) {
    super(baseURL);
  }

  async ping(): Promise<void> {
    await this.request({ method: 'GET', url: '/ping' });
  }

  createProcess(body: CreateProcessRequest): Promise<CreateProcessResponse> {
    // Validate processId format
    if (!validateProcessId(body.processId)) {
      throw new Error('Invalid processId format. Must be a 64-character hex string (32 bytes)');
    }

    return this.request({
      method: 'POST',
      url: '/processes',
      data: body,
    });
  }

  getProcess(processId: string): Promise<GetProcessResponse> {
    return this.request({
      method: 'GET',
      url: `/processes/${processId}`,
    });
  }

  listProcesses(): Promise<string[]> {
    return this.request<ListProcessesResponse>({
      method: 'GET',
      url: '/processes',
    }).then(res => res.processes);
  }

  async submitVote(vote: VoteRequest): Promise<void> {
    await this.request({
      method: 'POST',
      url: '/votes',
      data: vote,
    });
  }

  getVoteStatus(processId: string, voteId: string): Promise<VoteStatusResponse> {
    return this.request<VoteStatusResponse>({
      method: 'GET',
      url: `/votes/${processId}/voteId/${voteId}`,
    });
  }

  async hasAddressVoted(processId: string, address: string): Promise<boolean> {
    try {
      await this.request({
        method: 'GET',
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

  async getAddressWeight(processId: string, address: string): Promise<string> {
    const participant = await this.request<ParticipantInfoResponse>({
      method: 'GET',
      url: `/processes/${processId}/participants/${address}`,
    });
    return participant.weight;
  }

  async isAddressAbleToVote(processId: string, address: string): Promise<boolean> {
    try {
      await this.request<ParticipantInfoResponse>({
        method: 'GET',
        url: `/processes/${processId}/participants/${address}`,
      });
      return true;
    } catch (error: any) {
      // Only return false for "not in census" error
      if (error?.code === 40001) {
        return false;
      }
      // Throw for all other errors (invalid process ID, invalid address, etc.)
      throw error;
    }
  }

  getInfo(): Promise<InfoResponse> {
    return this.request<InfoResponse>({
      method: 'GET',
      url: '/info',
    });
  }

  pushMetadata(metadata: ElectionMetadata): Promise<string> {
    return this.request<{ hash: string }>({
      method: 'POST',
      url: '/metadata',
      data: metadata,
    }).then(res => res.hash);
  }

  async getMetadata(hashOrUrl: string): Promise<ElectionMetadata> {
    // Check if it's a URL
    if (hashOrUrl.startsWith('http://') || hashOrUrl.startsWith('https://')) {
      // Make direct HTTP request to the URL
      try {
        const response = await fetch(hashOrUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch metadata from URL: ${response.status} ${response.statusText}`
          );
        }
        return await response.json();
      } catch (error) {
        throw new Error(
          `Failed to fetch metadata from URL: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Treat as hash
    if (!isHexString(hashOrUrl)) {
      throw new Error('Invalid metadata hash format');
    }

    return this.request<ElectionMetadata>({
      method: 'GET',
      url: `/metadata/${hashOrUrl}`,
    });
  }

  getMetadataUrl(hash: string): string {
    if (!isHexString(hash)) throw new Error('Invalid metadata hash format');
    return `${this.axios.defaults.baseURL}/metadata/${hash}`;
  }

  getStats(): Promise<SequencerStats> {
    return this.request<SequencerStats>({
      method: 'GET',
      url: '/sequencer/stats',
    });
  }

  getWorkers(): Promise<WorkersResponse> {
    return this.request<WorkersResponse>({
      method: 'GET',
      url: '/sequencer/workers',
    });
  }
}
