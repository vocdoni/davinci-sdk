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
   * @param uri - Optional URI with census information
   */
  constructor(contractAddress: string, uri?: string) {
    super(CensusOrigin.Onchain);

    // Validate contract address
    if (!/^(0x)?[0-9a-fA-F]{40}$/i.test(contractAddress)) {
      throw new Error('Contract address is missing or invalid');
    }

    this._contractAddress = contractAddress;
    
    // For onchain census, these are known immediately
    this._censusRoot = contractAddress; // Contract address serves as root
    this._censusURI = uri || `contract://${contractAddress}`;
  }

  get contractAddress(): string {
    return this._contractAddress;
  }
}
