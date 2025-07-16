import { ElectionMetadata } from "../core/types";

/**
 * Common election configuration options
 */
export interface ElectionConfig {
  /** Election title */
  title: string;
  /** Election description */
  description?: string;
  /** Duration in seconds */
  duration: number;
  /** Start time (optional, defaults to now) */
  startTime?: Date;
  /** Census root hash */
  censusRoot: string;
  /** Maximum number of votes */
  maxVotes: string;
  /** Media attachments */
  media?: {
    header?: string;
    logo?: string;
  };
}

/**
 * Choice definition for elections
 */
export interface ElectionChoice {
  /** Choice title */
  title: string;
  /** Choice value (auto-assigned if not provided) */
  value?: number;
  /** Additional metadata */
  meta?: any;
}

/**
 * Result of creating an election
 */
export interface ElectionResult {
  /** The process ID */
  processId: string;
  /** Transaction hash from blockchain */
  transactionHash: string;
  /** Encryption public key */
  encryptionPubKey: [string, string];
  /** State root */
  stateRoot: string;
  /** Metadata hash */
  metadataHash: string;
  /** Election metadata */
  metadata: ElectionMetadata;
}

/**
 * Election status enum
 */
export enum ElectionStatus {
  UPCOMING = 'UPCOMING',
  ONGOING = 'ONGOING',
  ENDED = 'ENDED',
  CANCELED = 'CANCELED',
  PAUSED = 'PAUSED',
  RESULTS = 'RESULTS'
}

/**
 * Vote validation result
 */
export interface VoteValidationResult {
  valid: boolean;
  errors: string[];
}
