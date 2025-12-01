import { BallotMode, CensusData, EncryptionKey } from '../../core/types';
import { CensusOrigin, CensusProof } from '../../census/types';

export interface CreateProcessRequest {
  processId: string;
  census: {
    censusOrigin: CensusOrigin;
    censusRoot: string;
    censusURI: string;
  };
  ballotMode: BallotMode;
  signature: string;
}

export interface CreateProcessResponse {
  processId: string;
  encryptionPubKey: [string, string];
  stateRoot: string;
  ballotMode: BallotMode;
}

export interface GetProcessResponse {
  id: string;
  status: number;
  organizationId: string;
  encryptionKey: EncryptionKey;
  stateRoot: string;
  result: string[];
  startTime: number;
  duration: number;
  metadataURI: string;
  ballotMode: BallotMode;
  census: CensusData;
  metadata: {
    title: Record<string, string>;
    description: Record<string, string>;
    media: {
      header: string;
      logo: string;
    };
    questions: {
      title: Record<string, string>;
      description: Record<string, string>;
      choices: {
        title: Record<string, string>;
        value: number;
        meta: Record<string, string>;
      }[];
      meta: Record<string, string>;
    }[];
    processType: {
      name: string;
      properties: Record<string, string>;
    };
  };
  voteCount: string;
  voteOverwrittenCount: string;
  isAcceptingVotes: boolean;
  sequencerStats: {
    stateTransitionCount: number;
    lastStateTransitionDate: string;
    settledStateTransitionCount: number;
    aggregatedVotesCount: number;
    verifiedVotesCount: number;
    pendingVotesCount: number;
    currentBatchSize: number;
    lastBatchSize: number;
  };
}

export interface VoteCiphertext {
  c1: [string, string];
  c2: [string, string];
}

export interface VoteBallot {
  curveType: string;
  ciphertexts: VoteCiphertext[];
}

export interface VoteProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
}

export interface VoteRequest {
  /** The `processId` you obtained when creating the process. */
  processId: string;
  /** Your census proof (only required for CSP, not for MerkleTree). */
  censusProof?: CensusProof;
  /** Your encrypted ballot. */
  ballot: VoteBallot;
  /** The zkSNARK proof that the ballot is well‐formed. */
  ballotProof: VoteProof;
  /** Hash of the ballot inputs (decimal string). */
  ballotInputsHash: string;
  /** Your Ethereum address (hex-prefixed). */
  address: string;
  /** Signature over the raw bytes of the voteId. */
  signature: string;
  /** The vote ID (hex-prefixed). */
  voteId: string;
}

export interface InfoResponse {
  circuitUrl: string;
  circuitHash: string;
  provingKeyUrl: string;
  provingKeyHash: string;
  verificationKeyUrl: string;
  verificationKeyHash: string;
  ballotProofWasmHelperUrl: string;
  ballotProofWasmHelperHash: string;
  ballotProofWasmHelperExecJsUrl: string;
  ballotProofWasmHelperExecJsHash: string;
  contracts: {
    process: string;
    organization: string;
    stateTransitionVerifier: string;
    resultsVerifier: string;
  };
  network: {
    [key: string]: number;
  };
}

export enum VoteStatus {
  Pending = 'pending',
  Verified = 'verified',
  Aggregated = 'aggregated',
  Processed = 'processed',
  Settled = 'settled',
  Error = 'error',
}

export interface VoteStatusResponse {
  status: VoteStatus;
}

export interface ListProcessesResponse {
  processes: string[];
}

export interface SequencerStats {
  activeProcesses: number;
  pendingVotes: number;
  verifiedVotes: number;
  aggregatedVotes: number;
  stateTransitions: number;
  settledStateTransitions: number;
  lastStateTransitionDate: string;
}

export interface WorkerStats {
  name: string;
  successCount: number;
  failedCount: number;
}

export interface WorkersResponse {
  workers: WorkerStats[];
}

export interface ParticipantInfoResponse {
  key: string;
  weight: string;
}
