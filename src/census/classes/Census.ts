import type { RegistryCensus } from '../../contracts/types';
import { CensusError } from '../errors';
import { CensusOrigin } from '../types';

/**
 * A process census: its origin, and once known the root and URI the
 * registry stores. Roots are `bytes32` hex (lowercase, `0x` and 64 digits).
 */
export abstract class Census {
  protected _censusRoot: string | null = null;
  protected _censusURI: string | null = null;

  constructor(protected readonly _censusOrigin: CensusOrigin) {}

  /** The root the registry gets; null until a Merkle census is published. */
  get censusRoot(): string | null {
    return this._censusRoot;
  }

  /** Where nodes download the census, or voters find the CSP; null until published. */
  get censusURI(): string | null {
    return this._censusURI;
  }

  /** Root and URI are both known. */
  get isPublished(): boolean {
    return this._censusRoot !== null && this._censusURI !== null;
  }

  /** The census origin (static or updatable Merkle, on-chain contract, CSP). */
  get censusOrigin(): CensusOrigin {
    return this._censusOrigin;
  }

  /** Merkle censuses are uploaded before a process can use them; the others are ready. */
  get requiresPublishing(): boolean {
    return (
      this._censusOrigin === CensusOrigin.OffchainStatic ||
      this._censusOrigin === CensusOrigin.OffchainDynamic
    );
  }

  /** The census contract of an on-chain census; undefined for the others. */
  get contractAddress(): string | undefined {
    return undefined;
  }

  /**
   * The census as `newProcess` and `setProcessCensus` take it.
   *
   * @throws CensusError when the census is not published yet
   */
  toRegistryCensus(): RegistryCensus {
    if (this._censusRoot === null || this._censusURI === null) {
      throw new CensusError('the census must be published before a process can use it');
    }
    return {
      origin: this._censusOrigin,
      root: this._censusRoot,
      uri: this._censusURI,
      ...(this.contractAddress !== undefined && { contractAddress: this.contractAddress }),
    };
  }
}
