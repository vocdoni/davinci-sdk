/**
 * Election type metadata for storing in election metadata
 */
export interface ElectionTypeMetadata {
  type: 'approval' | 'rating' | 'ranking' | 'quadratic' | 'basic';
  version: string;
  config: ElectionTypeConfig;
}

/**
 * Union type for all election type configurations
 */
export type ElectionTypeConfig = 
  | ApprovalElectionConfig
  | RatingElectionConfig
  | RankingElectionConfig
  | QuadraticElectionConfig
  | BasicElectionConfig;

/**
 * Approval election configuration
 */
export interface ApprovalElectionConfig {
  minApprovals?: number;
  maxApprovals?: number;
}

/**
 * Rating election configuration
 */
export interface RatingElectionConfig {
  minRating?: number;
  maxRating?: number;
  minTotalRating?: number;
  maxTotalRating?: number;
}

/**
 * Ranking election configuration
 */
export interface RankingElectionConfig {
  allowPartialRanking?: boolean;
  minRankedChoices?: number;
}

/**
 * Quadratic election configuration
 */
export interface QuadraticElectionConfig {
  totalCredits?: number;
  useCensusWeightAsBudget?: boolean;
  minStep?: number;
  forceFullBudget?: boolean;
}

/**
 * Basic election configuration (fallback)
 */
export interface BasicElectionConfig {
  // Basic elections have no special configuration
}

/**
 * Process information retrieved from smart contract
 */
export interface ProcessInfo {
  processId: string;
  status: number;
  startTime: number;
  duration: number;
  ballotMode: any;
  census: any;
  metadataUri: string;
  encryptionKey: any;
  stateRoot: string;
}
