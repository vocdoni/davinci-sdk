import { CensusOrigin } from '../../../src/census';

export interface BallotMode {
  numFields: number;
  maxValue: string;
  minValue: string;
  uniqueValues: boolean;
  costFromWeight: boolean;
  costExponent: number;
  maxValueSum: string;
  minValueSum: string;
}

export interface CensusData {
  censusOrigin: CensusOrigin;
  censusRoot: string;
  /**
   * Contract address for onchain censuses (ERC20/ERC721 token contract).
   * For offchain censuses, defaults to zero address.
   * @default "0x0000000000000000000000000000000000000000"
   */
  contractAddress?: string;
  censusURI: string;
  /**
   * For onchain censuses, allows any valid Merkle root from the onchain source.
   * For other census types, set to false to require the specific censusRoot.
   * @default false
   */
  onchainAllowAnyValidRoot?: boolean;
}

export interface EncryptionKey {
  x: string;
  y: string;
}
