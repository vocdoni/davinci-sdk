/**
 * @fileoverview Deploying an `OwnedCensus` (davinci-onchain-census-contract)
 * from the creation code vendored in `contracts/census.json`
 * (`yarn sync:abis --census`). Its Keccak lean-IMT links no library.
 */

import { ContractFactory, getAddress, keccak256, type Signer } from 'ethers';
import { OWNED_CENSUS_ABI } from '../../src/contracts/abis';
import vendored from './contracts/census.json';

const code = vendored.contracts;

/** The census contract's source commit. */
export const CENSUS_CONTRACT_COMMIT = vendored.commit;

/** `OwnedCensus` creation code. */
export const OWNED_CENSUS_BYTECODE: string = code.OwnedCensus.bytecode;

/**
 * `bytecode` without the CBOR metadata solc appends (its length is the last two
 * bytes). The metadata hash depends on where and how a checkout was built, so
 * two builds of one commit compare equal only without it.
 */
export function withoutMetadata(bytecode: string): string {
  const hex = bytecode.toLowerCase();
  const length = Number.parseInt(hex.slice(-4), 16);
  if (!/^0x[0-9a-f]*$/.test(hex) || Number.isNaN(length) || (length + 2) * 2 > hex.length - 2) {
    return hex;
  }
  return hex.slice(0, hex.length - (length + 2) * 2);
}

/** Whether `runtime` is the vendored `OwnedCensus`'s runtime code, metadata aside. */
export function isOwnedCensus(runtime: string): boolean {
  return keccak256(withoutMetadata(runtime)) === code.OwnedCensus.deployedBytecodeHash;
}

/** What {@link deployOwnedCensus} deployed. */
export interface DeployedCensus {
  /** The `OwnedCensus`, owned by the deployer. */
  address: string;
}

/**
 * Deploys an `OwnedCensus` owned by `signer`. `onTx` gets the deployment's
 * label and transaction hash as it is sent.
 */
export async function deployOwnedCensus(
  signer: Signer,
  onTx: (label: string, hash: string) => void = () => undefined
): Promise<DeployedCensus> {
  if (!signer.provider) throw new Error('deploying a census needs a signer with a provider');
  const contract = await new ContractFactory(
    OWNED_CENSUS_ABI,
    OWNED_CENSUS_BYTECODE,
    signer
  ).deploy();
  const tx = contract.deploymentTransaction();
  if (tx) onTx('deploy OwnedCensus', tx.hash);
  await contract.waitForDeployment();
  return { address: getAddress(await contract.getAddress()) };
}
