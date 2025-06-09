import { BallotMode, Census, EncryptionKey } from '../../core/types';

export interface CreateProcessRequest {
    censusRoot: string;
    ballotMode: BallotMode;
    nonce: number;
    chainId: number;
    signature: string;
}

export interface CreateProcessResponse {
    processId: string;
    encryptionPubKey: [string, string];
    stateRoot: string;
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
    census: Census;
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
}

export interface CensusParticipant {
    key: string;
    weight?: string;
}

export interface CensusProof {
    /** The Merkle root (hex-prefixed). */
    root: string;
    /** The voter’s address (hex-prefixed). */
    key: string;
    /** The leaf value (hex-prefixed weight). */
    value: string;
    /** The serialized sibling path (hex-prefixed). */
    siblings: string;
    /** The weight as a decimal string. */
    weight: string;
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
    pi_b: [ [string, string], [string, string], [string, string] ];
    pi_c: [string, string, string];
    protocol: string;
}

export interface VoteRequest {
    /** The `processId` you obtained when creating the process. */
    processId: string;
    /** The Poseidon commitment over your vote. */
    commitment: string;
    /** The nullifier to prevent double‐voting. */
    nullifier: string;
    /** Your Merkle‐proof that you’re in the census. */
    censusProof: CensusProof;
    /** Your encrypted ballot. */
    ballot: VoteBallot;
    /** The zkSNARK proof that the ballot is well‐formed. */
    ballotProof: VoteProof;
    /** Hash of the ballot inputs (decimal string). */
    ballotInputsHash: string;
    /** Your Ethereum address (hex-prefixed). */
    address: string;
    /** Signature over the raw bytes of the voteID. */
    signature: string;
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
}

export enum VoteStatus {
    Pending    = "pending",
    Verified   = "verified",
    Aggregated = "aggregated",
    Processed  = "processed",
    Settled    = "settled",
    Error      = "error",
}

export interface VoteStatusResponse {
    status: VoteStatus;
}
