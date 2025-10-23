import { Census, CensusType } from './Census';

/**
 * CSP (Certificate Service Provider) census
 * Uses a public key and CSP server URI instead of a participant list
 */
export class CspCensus extends Census {
  private _publicKey: string;
  private _cspURI: string;

  constructor(publicKey: string, cspURI: string, size: number) {
    super(CensusType.CSP);

    // Validate public key
    if (!/^(0x)?[0-9a-fA-F]+$/.test(publicKey)) {
      throw new Error('Public key is missing or invalid');
    }

    // Validate CSP URI
    try {
      new URL(cspURI);
    } catch {
      throw new Error('CSP URI is missing or invalid');
    }

    this._publicKey = publicKey;
    this._cspURI = cspURI;

    // For CSP, these are known immediately
    this._censusRoot = publicKey; // Public key serves as root
    this._censusURI = cspURI;
    this._size = size;
  }

  get publicKey(): string {
    return this._publicKey;
  }

  get cspURI(): string {
    return this._cspURI;
  }
}
