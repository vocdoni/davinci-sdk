import { Census, CensusType, CensusParticipant } from './Census';
import { CensusOrigin } from '../types';

/**
 * Participant with flexible weight type for WeightedCensus
 * Weight can be string, number, or bigint - will be normalized to string internally
 */
export interface WeightedParticipant {
  key: string;
  weight: string | number | bigint;
}

/**
 * Weighted census where participants can have different voting power
 * Requires specifying weight for each participant
 */
export class WeightedCensus extends Census {
  private _participants: Map<string, string> = new Map();

  /**
   * Creates a new WeightedCensus
   * @param censusOrigin - The census origin (defaults to OffchainStatic for backward compatibility)
   */
  constructor(censusOrigin?: CensusOrigin) {
    super(CensusType.WEIGHTED, censusOrigin);
  }

  /**
   * Add participant(s) with custom weights
   * Weight can be provided as string, number, or bigint - will be converted to string internally
   * @param participant - Single participant or array of participants with custom weights
   */
  add(participant: WeightedParticipant | WeightedParticipant[]): void {
    const toAdd = Array.isArray(participant) ? participant : [participant];

    for (const p of toAdd) {
      this.validateParticipant(p);
      const weightString = this.normalizeWeight(p.weight);
      this._participants.set(p.key.toLowerCase(), weightString);
    }
  }

  /**
   * Remove participant by address
   */
  remove(address: string): void {
    this._participants.delete(address.toLowerCase());
  }

  /**
   * Get all participants as CensusParticipant array
   */
  get participants(): CensusParticipant[] {
    return Array.from(this._participants.entries()).map(([key, weight]) => ({
      key,
      weight,
    }));
  }

  /**
   * Get participant addresses
   */
  get addresses(): string[] {
    return Array.from(this._participants.keys());
  }

  /**
   * Get weight for specific address
   */
  getWeight(address: string): string | undefined {
    return this._participants.get(address.toLowerCase());
  }

  /**
   * Normalizes weight from string, number, or bigint to string
   */
  private normalizeWeight(weight: string | number | bigint): string {
    if (typeof weight === 'string') {
      // Validate it's a positive integer string
      if (!/^\d+$/.test(weight)) {
        throw new Error(`Invalid weight format: ${weight}. Must be a positive integer.`);
      }
      return weight;
    }
    
    if (typeof weight === 'number') {
      // Validate it's a positive integer
      if (!Number.isInteger(weight) || weight < 0) {
        throw new Error(`Invalid weight: ${weight}. Must be a positive integer.`);
      }
      return weight.toString();
    }
    
    if (typeof weight === 'bigint') {
      // Validate it's positive
      if (weight < 0n) {
        throw new Error(`Invalid weight: ${weight}. Must be a positive integer.`);
      }
      return weight.toString();
    }
    
    throw new Error(`Invalid weight type. Must be string, number, or bigint.`);
  }

  private validateParticipant(participant: WeightedParticipant): void {
    if (!participant.key || typeof participant.key !== 'string') {
      throw new Error('Participant key (address) is required');
    }
    // Basic format check
    if (!/^(0x)?[0-9a-fA-F]{40}$/i.test(participant.key)) {
      throw new Error(`Invalid Ethereum address format: ${participant.key}`);
    }
    if (participant.weight === undefined || participant.weight === null) {
      throw new Error('Participant weight is required');
    }
    // Weight validation is done in normalizeWeight
  }

  /**
   * Internal method called after publishing
   * @internal
   */
  _setPublishedData(root: string, uri: string, size: number, censusId?: string): void {
    this._censusRoot = root;
    this._censusURI = uri;
    this._size = size;
    if (censusId) this._censusId = censusId;
  }
}
