import { Census } from './Census';
import { CensusOrigin } from '../types';

/**
 * Onchain census that references a smart contract
 * Does not require publishing as it references an existing on-chain contract
 */
export class OnchainCensus extends Census {
  private _contractAddress: string;

  /**
   * Creates an OnchainCensus
   * @param contractAddress - The address of the smart contract (e.g., ERC20, ERC721)
   * @param uri - The URI pointing to census data source (e.g., subgraph endpoint)
   */
  constructor(contractAddress: string, uri: string) {
    super(CensusOrigin.Onchain);

    // Validate contract address
    if (!/^(0x)?[0-9a-fA-F]{40}$/i.test(contractAddress)) {
      throw new Error('Contract address is missing or invalid');
    }

    if (!uri || uri.trim() === '') {
      throw new Error('URI is required for onchain census');
    }

    this._contractAddress = contractAddress;
    
    // For onchain census with contractAddress, censusRoot must be 32-byte zero value
    this._censusRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
    this._censusURI = uri;
  }

  get contractAddress(): string {
    return this._contractAddress;
  }
}
