import { Census } from './Census';
import { CensusOrigin, CensusParticipant } from '../types';

/**
 * Participant with flexible weight type for MerkleCensus
 * Weight can be string, number, or bigint - will be normalized to string internally
 */
export interface Participant {
  key: string;
  weight: string | number | bigint;
}

/**
 * Abstract base class for Merkle Tree censuses
 * Supports both plain addresses (weight=1) and weighted participants
 */
export abstract class MerkleCensus extends Census {
  private _participants: Map<string, string> = new Map();

  constructor(censusOrigin: CensusOrigin) {
    super(censusOrigin);
  }

  /**
   * Add participant(s) - supports both plain addresses and weighted participants
   * @param data - Can be:
   *   - string: single address (weight=1)
   *   - string[]: array of addresses (weight=1 for all)
   *   - {key: string, weight: string|number|bigint}: single weighted participant
   *   - Array of weighted participants
   */
  add(data: string | string[] | Participant | Participant[]): void {
    if (typeof data === 'string') {
      // Single address
      this.addAddress(data, '1');
    } else if (Array.isArray(data)) {
      if (data.length === 0) return;

      // Check first element to determine type
      if (typeof data[0] === 'string') {
        // Array of plain addresses
        (data as string[]).forEach(addr => this.addAddress(addr, '1'));
      } else {
        // Array of weighted participants
        (data as Participant[]).forEach(p => this.addParticipant(p));
      }
    } else {
      // Single weighted participant
      this.addParticipant(data);
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
   * Internal method to add a plain address with a given weight
   */
  private addAddress(address: string, weight: string): void {
    this.validateAddress(address);
    this._participants.set(address.toLowerCase(), weight);
  }

  /**
   * Internal method to add a weighted participant
   */
  private addParticipant(participant: Participant): void {
    this.validateAddress(participant.key);
    const weight = this.normalizeWeight(participant.weight);
    this._participants.set(participant.key.toLowerCase(), weight);
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

  /**
   * Validates Ethereum address format
   */
  private validateAddress(address: string): void {
    if (!address || typeof address !== 'string') {
      throw new Error('Address is required and must be a string');
    }
    // Basic format check
    if (!/^(0x)?[0-9a-fA-F]{40}$/i.test(address)) {
      throw new Error(`Invalid Ethereum address format: ${address}`);
    }
  }

  /**
   * Internal method called after publishing
   * @internal
   */
  _setPublishedData(root: string, uri: string, censusId?: string): void {
    this._censusRoot = root;
    this._censusURI = uri;
    if (censusId) this._censusId = censusId;
  }
}
