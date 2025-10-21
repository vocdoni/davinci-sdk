import { Census, CensusType, CensusParticipant } from './Census';

/**
 * Plain census where all participants have equal voting power (weight=1)
 * Simpler API - just add addresses without specifying weights
 */
export class PlainCensus extends Census {
  private _participants: Set<string> = new Set();

  constructor() {
    super(CensusType.PLAIN);
  }

  /**
   * Add participant(s) with automatic weight=1
   * @param addresses - Single address or array of addresses
   */
  add(addresses: string | string[]): void {
    const toAdd = Array.isArray(addresses) ? addresses : [addresses];

    for (const address of toAdd) {
      this.validateAddress(address);
      this._participants.add(address.toLowerCase());
    }
  }

  /**
   * Remove participant by address
   */
  remove(address: string): void {
    this._participants.delete(address.toLowerCase());
  }

  /**
   * Get all participants as CensusParticipant array (for API)
   * All participants have weight="1"
   */
  get participants(): CensusParticipant[] {
    return Array.from(this._participants).map(key => ({
      key,
      weight: '1', // Everyone has weight=1 in plain census
    }));
  }

  /**
   * Get addresses only
   */
  get addresses(): string[] {
    return Array.from(this._participants);
  }

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
  _setPublishedData(root: string, uri: string, size: number, censusId?: string): void {
    this._censusRoot = root;
    this._censusURI = uri;
    this._size = size;
    if (censusId) this._censusId = censusId;
  }
}
