/**
 * Census origin types
 */
export enum CensusOrigin {
  /** Offchain static Merkle Tree census */
  OffchainStatic = 1,
  /** Offchain dynamic Merkle Tree census */
  OffchainDynamic = 2,
  /** Onchain Merkle Tree census */
  Onchain = 3,
  /** Credential Service Provider (CSP) census using EdDSA BLS12-377 */
  CSP = 4,
}

export interface CensusParticipant {
  key: string;
  weight?: string;
}

export interface BaseCensusProof {
  /** The Merkle root (hex-prefixed). */
  root: string;
  /** The voter's address (hex-prefixed). */
  address: string;
  /** The weight as a decimal string. */
  weight: string;
  /** Census origin type: OffchainStatic/OffchainDynamic/Onchain for merkle proofs, CSP for csp proofs */
  censusOrigin: CensusOrigin;
}

export interface MerkleCensusProof extends BaseCensusProof {
  censusOrigin: CensusOrigin.OffchainStatic | CensusOrigin.OffchainDynamic | CensusOrigin.Onchain;
  /** The leaf value (hex-prefixed weight). */
  value: string;
  /** The serialized sibling path (hex-prefixed). */
  siblings: string;
}

export interface CSPCensusProof extends BaseCensusProof {
  censusOrigin: CensusOrigin.CSP;
  /** The process id signed with the address (hex-prefixed). */
  processId: string;
  /** The public key of the csp (hex-prefixed). */
  publicKey: string;
  /** The signature that proves that the voter is in the census (hex-prefixed). */
  signature: string;
}

export type CensusProof = MerkleCensusProof | CSPCensusProof;

/**
 * Provider function for Merkle census proofs
 */
export type MerkleCensusProofProvider = (args: {
  censusRoot: string;
  address: string;
}) => Promise<MerkleCensusProof>;

/**
 * Provider function for CSP census proofs
 */
export type CSPCensusProofProvider = (args: {
  processId: string;
  address: string;
}) => Promise<CSPCensusProof>;

/**
 * Configuration for census proof providers
 */
export interface CensusProviders {
  /** Optional override for Merkle census proof fetching */
  merkle?: MerkleCensusProofProvider;
  /** Required provider for CSP census proof generation */
  csp?: CSPCensusProofProvider;
}

/**
 * Runtime validation functions for census proofs
 */

/**
 * Type guard to check if an object is a valid BaseCensusProof
 */
function isBaseCensusProof(proof: any): proof is BaseCensusProof {
  return (
    !!proof &&
    typeof proof.root === 'string' &&
    typeof proof.address === 'string' &&
    typeof proof.censusOrigin === 'number' &&
    Object.values(CensusOrigin).includes(proof.censusOrigin)
  );
}

/**
 * Type guard to check if an object is a valid MerkleCensusProof
 */
export function isMerkleCensusProof(proof: any): proof is MerkleCensusProof {
  return (
    isBaseCensusProof(proof) &&
    (proof.censusOrigin === CensusOrigin.OffchainStatic ||
      proof.censusOrigin === CensusOrigin.OffchainDynamic ||
      proof.censusOrigin === CensusOrigin.Onchain) &&
    typeof (proof as any).weight === 'string' &&
    typeof (proof as any).value === 'string' &&
    typeof (proof as any).siblings === 'string'
  );
}

/**
 * Type guard to check if an object is a valid CSPCensusProof
 */
export function isCSPCensusProof(proof: any): proof is CSPCensusProof {
  return (
    isBaseCensusProof(proof) &&
    proof.censusOrigin === CensusOrigin.CSP &&
    typeof (proof as any).weight === 'string' &&
    typeof (proof as any).processId === 'string' &&
    typeof (proof as any).publicKey === 'string' &&
    typeof (proof as any).signature === 'string'
  );
}

/**
 * Assertion function to validate MerkleCensusProof
 */
export function assertMerkleCensusProof(proof: unknown): asserts proof is MerkleCensusProof {
  if (!isMerkleCensusProof(proof)) {
    throw new Error('Invalid Merkle census proof payload');
  }
}

/**
 * Assertion function to validate CSPCensusProof
 */
export function assertCSPCensusProof(proof: unknown): asserts proof is CSPCensusProof {
  if (!isCSPCensusProof(proof)) {
    throw new Error('Invalid CSP census proof payload');
  }
}

export interface PublishCensusResponse {
  /** The Merkle root of the published census (hex-prefixed). */
  root: string;
  /** The number of participants in the census. */
  participantCount: number;
  /** ISO timestamp when the working census was created. */
  createdAt: string;
  /** ISO timestamp when the census was published. */
  publishedAt: string;
  /** The constructed URI for accessing the census */
  uri: string;
  /** The size of the census. */
  size: number;
}

export interface Snapshot {
  /** ISO timestamp of the snapshot date. */
  snapshotDate: string;
  /** The Merkle root of the census (hex-prefixed). */
  censusRoot: string;
  /** The number of participants in the census. */
  participantCount: number;
  /** Minimum balance filter applied. */
  minBalance: number;
  /** User-defined query name. */
  queryName: string;
  /** ISO timestamp when the snapshot was created. */
  createdAt: string;
  /** Type of query executed (optional). */
  queryType?: string;
  /** Token decimals (optional). */
  decimals?: number;
  /** Query execution period (optional). */
  period?: string;
  /** Query parameters (optional). */
  parameters?: Record<string, any>;
  /** Weight configuration (optional). */
  weightConfig?: {
    strategy: string;
    targetMinWeight: number;
    maxWeight: number;
  };
}

export interface SnapshotsResponse {
  /** Array of snapshots. */
  snapshots: Snapshot[];
  /** Total number of snapshots. */
  total: number;
  /** Current page number. */
  page: number;
  /** Number of items per page. */
  pageSize: number;
  /** Whether there is a next page. */
  hasNext: boolean;
  /** Whether there is a previous page. */
  hasPrev: boolean;
}

export interface SnapshotsQueryParams {
  /** Page number (default: 1). */
  page?: number;
  /** Items per page (default: 20, max: 100). */
  pageSize?: number;
  /** Filter by minimum balance. */
  minBalance?: number;
  /** Filter by user-defined query name. */
  queryName?: string;
}

export interface CensusSizeResponse {
  /** The number of participants in the census. */
  size: number;
}

export interface HealthResponse {
  /** Service status. */
  status: string;
  /** ISO timestamp of the health check. */
  timestamp: string;
  /** Service name. */
  service: string;
}
