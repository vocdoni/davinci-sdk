import { Census, CensusType } from './Census';
import { CensusOrigin } from '../types';

/**
 * Published census - represents a census that has already been published
 * Use this when you have the census root, URI, and size from a previous publication
 */
export class PublishedCensus extends Census {
  /**
   * Creates a PublishedCensus from existing census data
   * @param type - The census type (PLAIN, WEIGHTED, or CSP)
   * @param root - The census root
   * @param uri - The census URI
   * @param size - The census size (number of participants)
   * @param censusOrigin - The census origin (optional - defaults based on type if not provided)
   */
  constructor(type: CensusType, root: string, uri: string, size: number, censusOrigin?: CensusOrigin) {
    super(type, censusOrigin);
    this._censusRoot = root;
    this._censusURI = uri;
    this._size = size;
  }
}
