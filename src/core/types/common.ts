import { CensusOrigin } from '../../../src/census';

export interface BallotMode {
  numFields: number;
  maxValue: string;
  minValue: string;
  uniqueValues: boolean;
  costFromWeight: boolean;
  costExponent: number;
  maxValueSum: string;
  minValueSum: string;
}

export interface Census {
  censusOrigin: CensusOrigin;
  maxVotes: string;
  censusRoot: string;
  censusURI: string;
}

export interface EncryptionKey {
  x: string;
  y: string;
}
