export interface BallotMode {
    maxCount: number;
    maxValue: string;
    minValue: string;
    forceUniqueness: boolean;
    costFromWeight: boolean;
    costExponent: number;
    maxTotalCost: string;
    minTotalCost: string;
}

export interface Census {
    censusOrigin: number;
    maxVotes: string;
    censusRoot: string;
    censusURI: string;
}

export interface EncryptionKey {
    x: string;
    y: string;
}
