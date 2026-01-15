import { Census } from './Census';
import { CensusOrigin } from '../types';

/**
 * Published census - represents a census that has already been published
 * Use this when you have the census root and URI from a previous publication
 */
export class PublishedCensus extends Census {
  /**
   * Creates a PublishedCensus from existing census data
   * @param censusOrigin - The census origin (OffchainStatic, OffchainDynamic, Onchain, or CSP)
   * @param root - The census root
   * @param uri - The census URI
   */
  constructor(censusOrigin: CensusOrigin, root: string, uri: string) {
    super(censusOrigin);
    this._censusRoot = root;
    this._censusURI = uri;
  }
}
