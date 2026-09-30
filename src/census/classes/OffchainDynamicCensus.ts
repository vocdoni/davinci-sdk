import { MerkleCensus } from './MerkleCensus';
import { CensusOrigin } from '../types';

/**
 * Updatable Merkle census (origin 2): the organizer can publish a new
 * version and move the process to it (`updateCensus`) until the end. Nodes
 * load each new version in the background; a pending vote whose member was
 * removed or reweighted fails with `census changed, recast`.
 */
export class OffchainDynamicCensus extends MerkleCensus {
  constructor() {
    super(CensusOrigin.OffchainDynamic);
  }
}
