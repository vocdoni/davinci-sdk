import { toBeHex } from 'ethers';
import { BN254_FR } from '../../crypto/field';
import { CensusError } from '../errors';
import { CensusOrigin } from '../types';
import { Census } from './Census';

function rootValue(root: string | bigint): bigint {
  if (typeof root === 'bigint') return root;
  if (/^0x[0-9a-fA-F]{1,64}$/.test(root)) return BigInt(root);
  throw new CensusError(`census root ${root} is not a bigint or 0x hex of at most 32 bytes`);
}

/**
 * A census already published: a Merkle census whose file is served at `uri`
 * (origins 1 and 2), or a CSP's address (origin 4). Use {@link OnchainCensus}
 * for a census contract. `verifyCensusUrl` checks a Merkle census URL the way
 * nodes will read it.
 */
export class PublishedCensus extends Census {
  /**
   * @param censusOrigin - Static or updatable Merkle, or CSP
   * @param root - The lean-IMT root (a field element) or the CSP address, as
   *   a bigint or `0x` hex
   * @param uri - The census file URL, or where the CSP is
   * @throws CensusError for an on-chain origin, a root out of range or an empty URI
   */
  constructor(censusOrigin: CensusOrigin, root: string | bigint, uri: string) {
    super(censusOrigin);
    const value = rootValue(root);
    switch (censusOrigin) {
      case CensusOrigin.OffchainStatic:
      case CensusOrigin.OffchainDynamic:
        if (value === 0n || value >= BN254_FR) {
          throw new CensusError('a Merkle census root is a non-zero field element');
        }
        break;
      case CensusOrigin.CSP:
        if (value === 0n || value >> 160n !== 0n) {
          throw new CensusError('a CSP census root is the CSP address');
        }
        break;
      case CensusOrigin.Onchain:
        throw new CensusError('an on-chain census needs its contract: use OnchainCensus');
      default:
        throw new CensusError(`unknown census origin ${String(censusOrigin)}`);
    }
    if (typeof uri !== 'string' || uri.trim() === '') {
      throw new CensusError('the census URI must not be empty');
    }
    this._censusRoot = toBeHex(value, 32);
    this._censusURI = uri;
  }
}
