import { MerkleCensus } from './MerkleCensus';
import { CensusOrigin } from '../types';

/**
 * Static Merkle census (origin 1): its root is fixed when the process is
 * created. Plain addresses have weight 1; weighted members are allowed.
 */
export class OffchainCensus extends MerkleCensus {
  constructor() {
    super(CensusOrigin.OffchainStatic);
  }
}
