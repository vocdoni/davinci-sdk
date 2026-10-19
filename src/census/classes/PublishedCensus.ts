import { toBeHex } from 'ethers';
import { CensusError } from '../errors';
import { CensusOrigin } from '../types';
import { Census } from './Census';

// A Merkle root is a census value, `0x` and exactly 64 hex digits as every
// wire writes it; a CSP root is the CSP's address.
function rootValue(root: string | bigint, merkle: boolean): bigint {
  if (typeof root === 'bigint') return root;
  if ((merkle ? /^0x[0-9a-fA-F]{64}$/ : /^0x[0-9a-fA-F]{1,64}$/).test(root)) return BigInt(root);
  throw new CensusError(
    `census root ${root} is not a bigint or ${merkle ? '0x and 64 hex digits' : '0x hex of at most 32 bytes'}`
  );
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
   * @param root - The Keccak lean-IMT root, a bigint below 2^256 or `0x` and
   *   exactly 64 hex digits; or the CSP address, a bigint or `0x` hex of up to
   *   32 bytes
   * @param uri - The census file URL, or where the CSP is
   * @throws CensusError for an on-chain origin, a root out of range or an empty URI
   */
  constructor(censusOrigin: CensusOrigin, root: string | bigint, uri: string) {
    super(censusOrigin);
    let value: bigint;
    switch (censusOrigin) {
      case CensusOrigin.OffchainStatic:
      case CensusOrigin.OffchainDynamic:
        value = rootValue(root, true);
        if (value <= 0n || value >> 256n !== 0n) {
          throw new CensusError('a Merkle census root is a non-zero 256-bit value');
        }
        break;
      case CensusOrigin.CSP:
        value = rootValue(root, false);
        if (value <= 0n || value >> 160n !== 0n) {
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
