export interface CensusParticipant {
    key: string;
    weight?: string;
}

export interface CensusProof {
    /** The Merkle root (hex-prefixed). */
    root: string;
    /** The voter's address (hex-prefixed). */
    key: string;
    /** The leaf value (hex-prefixed weight). */
    value: string;
    /** The serialized sibling path (hex-prefixed). */
    siblings: string;
    /** The weight as a decimal string. */
    weight: string;
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
