import { MerkleCensus } from './MerkleCensus';
import { CensusOrigin } from '../types';

/**
 * Offchain dynamic Merkle Tree census
 * Supports both plain addresses (weight=1) and weighted participants
 */
export class OffchainDynamicCensus extends MerkleCensus {
  constructor() {
    super(CensusOrigin.OffchainDynamic);
  }
}
