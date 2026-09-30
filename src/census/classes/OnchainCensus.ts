import { ZeroHash, getAddress, type ContractRunner } from 'ethers';
import {
  OnchainCensusService,
  type OnchainCensusState,
} from '../../contracts/OnchainCensusService';
import { CensusError, CensusWitnessError } from '../errors';
import { CensusOrigin, type MerkleCensusWitness } from '../types';
import { Census } from './Census';

/**
 * An on-chain census (origin 3): a census contract of
 * davinci-onchain-census-contract, davinci-zkvm branch (append-only, fixed
 * weights, one ballot slot per member). The registry reads the root from the
 * contract at creation, so the root given is zero, and accepts any root the
 * contract recorded since the process began. Nodes index the members from
 * the contract's logs; the URI is informational.
 *
 * @example
 * ```typescript
 * const census = new OnchainCensus(contractAddress);
 * await census.check(provider); // optional: the contract is a davinci-zkvm census
 * ```
 */
export class OnchainCensus extends Census {
  private readonly _contractAddress: string;

  /**
   * @param contractAddress - The census contract
   * @param uri - What `censusURI` records (the registry needs one); default
   *   `onchain://<contract address>`
   * @throws CensusError for a bad address or an empty URI
   */
  constructor(contractAddress: string, uri?: string) {
    super(CensusOrigin.Onchain);
    try {
      this._contractAddress = getAddress(contractAddress);
    } catch {
      throw new CensusError(`not a contract address: ${contractAddress}`);
    }
    const u = uri ?? `onchain://${this._contractAddress}`;
    if (u.trim() === '') throw new CensusError('the census URI must not be empty');
    this._censusRoot = ZeroHash;
    this._censusURI = u;
  }

  get contractAddress(): string {
    return this._contractAddress;
  }

  /**
   * Checks the contract is a davinci-zkvm census and reads its root and
   * size (see `OnchainCensusService.check`).
   *
   * @throws CensusContractError
   */
  check(runner: ContractRunner): Promise<OnchainCensusState> {
    return new OnchainCensusService(this._contractAddress, runner).check();
  }

  /**
   * A member's witness: its weight on the contract. Nodes derive the proof
   * themselves, so none is attached.
   *
   * @throws CensusWitnessError when `address` is not a member
   */
  async witness(runner: ContractRunner, address: string): Promise<MerkleCensusWitness> {
    const weight = await new OnchainCensusService(this._contractAddress, runner).weightOf(address);
    if (weight === 0n) {
      throw new CensusWitnessError(`${address} is not in the census ${this._contractAddress}`);
    }
    return { type: 'merkle', weight };
  }
}
