import { CensusOrigin, CensusParticipant as ImportedCensusParticipant } from '../types';

/**
 * Re-export CensusParticipant from types for convenience
 * Extended to make weight required (base type has optional weight)
 */
export interface CensusParticipant extends ImportedCensusParticipant {
  weight: string; // Make weight required
}

/**
 * Abstract base class for all census types
 */
export abstract class Census {
  protected _censusId: string | null = null;
  protected _censusRoot: string | null = null;
  protected _censusURI: string | null = null;
  protected _censusOrigin: CensusOrigin;

  constructor(censusOrigin: CensusOrigin) {
    this._censusOrigin = censusOrigin;
  }

  get censusId(): string | null {
    return this._censusId;
  }

  get censusRoot(): string | null {
    return this._censusRoot;
  }

  get censusURI(): string | null {
    return this._censusURI;
  }

  get isPublished(): boolean {
    return this._censusRoot !== null && this._censusURI !== null;
  }

  /**
   * Get the census origin (OffchainStatic, OffchainDynamic, Onchain, or CSP)
   */
  get censusOrigin(): CensusOrigin {
    return this._censusOrigin;
  }

  /**
   * Check if this census requires publishing via the Census API
   * Merkle censuses (OffchainStatic, OffchainDynamic) need to be published
   * Onchain and CSP censuses are ready immediately upon construction
   */
  get requiresPublishing(): boolean {
    return (
      this._censusOrigin === CensusOrigin.OffchainStatic ||
      this._censusOrigin === CensusOrigin.OffchainDynamic
    );
  }
}
