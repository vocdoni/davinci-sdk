import { getAddress, zeroPadValue, type Signer } from 'ethers';
import { CensusError } from '../errors';
import { CensusOrigin } from '../types';
import { Census } from './Census';

/**
 * A CSP census (origin 4): a credential service provider signs one
 * attestation per voter with a secp256k1 key, and the census root is that
 * key's Ethereum address. Nodes download nothing; the URI tells voters where
 * the CSP is. See {@link CspSigner} for the CSP side.
 *
 * @example
 * ```typescript
 * const census = new CspCensus('0xCSP…', 'https://csp.example.org/process');
 * census.censusRoot; // the address, left-padded to 32 bytes
 * ```
 */
export class CspCensus extends Census {
  private readonly _cspAddress: string;

  /**
   * @param cspAddress - The CSP's Ethereum address
   * @param uri - Where voters get their attestations (the registry needs one)
   * @throws CensusError for a bad address or URI
   */
  constructor(cspAddress: string, uri: string) {
    super(CensusOrigin.CSP);
    try {
      this._cspAddress = getAddress(cspAddress);
    } catch {
      throw new CensusError(`not a CSP address: ${cspAddress}`);
    }
    try {
      new URL(uri);
    } catch {
      throw new CensusError(`the CSP URI is missing or invalid: ${uri}`);
    }
    this._censusRoot = zeroPadValue(this._cspAddress, 32).toLowerCase();
    this._censusURI = uri;
  }

  /** The census of a CSP whose key is `signer`. */
  static async fromSigner(signer: Signer, uri: string): Promise<CspCensus> {
    return new CspCensus(await signer.getAddress(), uri);
  }

  /** The CSP's address, checksummed. */
  get cspAddress(): string {
    return this._cspAddress;
  }
}
