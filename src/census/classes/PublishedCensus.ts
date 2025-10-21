import { Census, CensusType } from './Census';

/**
 * Published census - represents a census that has already been published
 * Use this when you have the census root, URI, and size from a previous publication
 */
export class PublishedCensus extends Census {
  constructor(type: CensusType, root: string, uri: string, size: number) {
    super(type);
    this._censusRoot = root;
    this._censusURI = uri;
    this._size = size;
  }
}
