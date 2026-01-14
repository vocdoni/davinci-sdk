import { CensusOrigin, CensusParticipant as ImportedCensusParticipant } from '../types';

/**
 * Census type enumeration
 */
export enum CensusType {
  PLAIN = 'plain',
  WEIGHTED = 'weighted',
  CSP = 'csp',
}

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
  protected _type: CensusType;
  protected _censusOrigin: CensusOrigin;
  protected _size: number | null = null;

  constructor(type: CensusType, censusOrigin?: CensusOrigin) {
    this._type = type;
    
    // If censusOrigin is provided, use it; otherwise derive from type
    if (censusOrigin !== undefined) {
      this._censusOrigin = censusOrigin;
    } else {
      // Default behavior for backward compatibility
      switch (type) {
        case CensusType.PLAIN:
        case CensusType.WEIGHTED:
          this._censusOrigin = CensusOrigin.OffchainStatic;
          break;
        case CensusType.CSP:
          this._censusOrigin = CensusOrigin.CSP;
          break;
        default:
          throw new Error(`Unknown census type: ${type}`);
      }
    }
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

  get type(): CensusType {
    return this._type;
  }

  get size(): number | null {
    return this._size;
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
}
