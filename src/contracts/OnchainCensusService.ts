/**
 * @fileoverview A census contract of davinci-onchain-census-contract (the
 * davinci-zkvm branch), the census of an origin-3 process: an append-only
 * lean-IMT of `(address << 88) | weight` leaves with fixed weights and one
 * ballot slot per member. Nodes build their tree from its `CensusMemberAdded`
 * logs; a weight change or two members on one slot makes it unusable.
 */

import { Contract, ZeroAddress, getAddress, type ContractRunner } from 'ethers';
import { OWNED_CENSUS_ABI } from './abis';
import { CensusContractError } from './errors';
import { SmartContractService, type TxStatusEvent } from './SmartContractService';
import { slotFromAddress } from '../crypto/census';
import { CENSUS_WEIGHT_BITS } from '../protocol/limits';

/** What {@link OnchainCensusService.check} read. */
export interface OnchainCensusState {
  /** The current lean-IMT root; zero before the first member. */
  root: bigint;
  /** Members so far. */
  size: number;
}

const WEIGHT_LIMIT = 1n << BigInt(CENSUS_WEIGHT_BITS);

function memberWeight(weight: bigint | number): bigint {
  const w = BigInt(weight);
  if (w <= 0n || w >= WEIGHT_LIMIT) {
    throw new CensusContractError(`weight ${w} is not in [1, 2^88)`, 'addMember');
  }
  return w;
}

/**
 * Reads a census contract and, for an `OwnedCensus`, adds members as its
 * owner. Reads work with any `OnchainCensus`; writes need the owner's signer.
 *
 * @example
 * ```typescript
 * const census = new OnchainCensusService(contractAddress, provider);
 * const { root, size } = await census.check();
 * const weight = await census.weightOf(voter); // 0 for a non-member
 * ```
 */
export class OnchainCensusService extends SmartContractService {
  private readonly contract: Contract;
  /** The contract address, checksummed. */
  readonly address: string;

  /**
   * @param contractAddress - The census contract
   * @param runner - A provider for reads; the owner's signer for writes
   * @param options - `receiptTimeoutMs`: longest wait for a receipt
   */
  constructor(
    contractAddress: string,
    runner: ContractRunner,
    options: { receiptTimeoutMs?: number } = {}
  ) {
    super();
    this.address = getAddress(contractAddress);
    this.contract = new Contract(this.address, OWNED_CENSUS_ABI, runner);
    if (options.receiptTimeoutMs !== undefined) this.receiptTimeoutMs = options.receiptTimeoutMs;
  }

  private async read(method: string, ...args: unknown[]): Promise<unknown> {
    try {
      return (await this.contract.getFunction(method).staticCall(...args)) as unknown;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      throw new CensusContractError(
        `census contract ${this.address}: ${method}: ${text}`,
        method,
        undefined,
        err
      );
    }
  }

  private async big(method: string, ...args: unknown[]): Promise<bigint> {
    const v = await this.read(method, ...args);
    if (typeof v !== 'bigint') {
      throw new CensusContractError(`${method}: want an integer`, method);
    }
    return v;
  }

  /** The current root (`ICensusValidator.getCensusRoot`). */
  getCensusRoot(): Promise<bigint> {
    return this.big('getCensusRoot');
  }

  /** Number of members. */
  async treeSize(): Promise<number> {
    const n = await this.big('treeSize');
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CensusContractError(`treeSize ${n} is out of range`, 'treeSize');
    }
    return Number(n);
  }

  /** A member's weight; 0 for an address that is not a member. */
  weightOf(address: string): Promise<bigint> {
    return this.big('weightOf', getAddress(address));
  }

  /** The ballot slot the contract derives for `address`. */
  slotOf(address: string): Promise<bigint> {
    return this.big('slotOf', getAddress(address));
  }

  /** The member holding `slot`, or null when it is free. */
  async slotOwner(slot: bigint): Promise<string | null> {
    const owner = await this.read('slotOwner', slot);
    if (typeof owner !== 'string')
      throw new CensusContractError('slotOwner: want an address', 'slotOwner');
    return owner === ZeroAddress ? null : getAddress(owner);
  }

  /** Sum of the member weights. */
  totalVotingPower(): Promise<bigint> {
    return this.big('totalVotingPower');
  }

  /**
   * Checks the address holds an append-only census of the davinci-zkvm
   * branch: there is code, its root and size answer, and its `slotOf`
   * derives the slot this SDK and the nodes do. A contract without `slotOf`
   * (the upstream census, whose weights can change) fails. That the contract
   * never changes a weight is not checked; nodes stop using one that does.
   *
   * @throws CensusContractError naming what fails
   */
  async check(): Promise<OnchainCensusState> {
    const provider = this.contract.runner?.provider;
    if (provider && (await provider.getCode(this.address)) === '0x') {
      throw new CensusContractError(`no contract at ${this.address}`, 'check');
    }
    const [root, size] = await Promise.all([this.getCensusRoot(), this.treeSize()]);
    let slot: bigint;
    try {
      slot = await this.slotOf(this.address);
    } catch (err) {
      throw new CensusContractError(
        `${this.address} has no slotOf: not a census contract of the davinci-zkvm branch`,
        'check',
        undefined,
        err
      );
    }
    if (slot !== slotFromAddress(this.address)) {
      throw new CensusContractError(
        `${this.address} derives ballot slot ${slot}, not ${slotFromAddress(this.address)}`,
        'check'
      );
    }
    return { root, size };
  }

  /**
   * `OwnedCensus.addMember`: adds `user` with `weight` (1 to 2^88 - 1). It
   * reverts `AlreadyRegisteredAddress`, `InvalidCensusWeight` or
   * `SlotTaken(existing)` (the error's `revertName`).
   */
  addMember(
    user: string,
    weight: bigint | number
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>, void, unknown> {
    return this.write('addMember', () => [getAddress(user), memberWeight(weight)]);
  }

  /** `OwnedCensus.addMembers`: adds each user with its weight; one bad entry reverts them all. */
  addMembers(
    users: readonly string[],
    weights: readonly (bigint | number)[]
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>, void, unknown> {
    return this.write('addMembers', () => {
      if (users.length !== weights.length) {
        throw new CensusContractError(
          `${users.length} users and ${weights.length} weights`,
          'addMembers'
        );
      }
      return [users.map(u => getAddress(u)), weights.map(memberWeight)];
    });
  }

  private write(
    method: string,
    args: () => readonly unknown[]
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>, void, unknown> {
    return this.sendContractTx({
      contract: this.contract,
      method,
      args,
      error: (message, revert, cause) => new CensusContractError(message, method, revert, cause),
      onReceipt: () => ({ success: true }),
    });
  }
}
