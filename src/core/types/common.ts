export interface BallotMode {
  numFields: number;
  /**
   * Number of choices grouped per encrypted chunk.
   * Defaults to numFields when omitted.
   */
  groupSize?: number;
  maxValue: string;
  minValue: string;
  uniqueValues: boolean;
  costExponent: number;
  maxValueSum: string;
  minValueSum: string;
}

export interface EncryptionKey {
  x: string;
  y: string;
}
