import { MerkleCensus } from './MerkleCensus';
import { CensusOrigin } from '../types';

/**
 * Offchain static Merkle Tree census (most common)
 * Supports both plain addresses (weight=1) and weighted participants
 */
export class OffchainCensus extends MerkleCensus {
  constructor() {
    super(CensusOrigin.OffchainStatic);
  }
}
