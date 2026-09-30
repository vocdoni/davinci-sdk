/**
 * @fileoverview Deploying an `OwnedCensus` (davinci-onchain-census-contract,
 * davinci-zkvm branch) from the creation code vendored in
 * `contracts/census.json` (`yarn sync:abis --census`), linked to its
 * `PoseidonT3` library: the copy poseidon-solidity deploys at the same
 * address on every chain when there is one, else a fresh one.
 */

import { ContractFactory, getAddress, keccak256, type InterfaceAbi, type Signer } from 'ethers';
import { OWNED_CENSUS_ABI } from '../../src/contracts/abis';
import vendored from './contracts/census.json';

/** Where poseidon-solidity's deterministic deployment puts `PoseidonT3`. */
export const POSEIDON_T3_ADDRESS = '0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93';

interface LinkReference {
  start: number;
  length: number;
}

const code = vendored.contracts;

/** The census contract's source commit. */
export const CENSUS_CONTRACT_COMMIT = vendored.commit;

/** `OwnedCensus` creation code with `PoseidonT3` at `library`. */
export function linkOwnedCensus(library: string): string {
  const address = getAddress(library).slice(2).toLowerCase();
  let hex = code.OwnedCensus.bytecode.slice(2);
  const refs = Object.values(code.OwnedCensus.linkReferences) as Record<string, LinkReference[]>[];
  let linked = 0;
  for (const byLibrary of refs) {
    for (const [name, at] of Object.entries(byLibrary)) {
      if (name !== 'PoseidonT3') throw new Error(`OwnedCensus links an unknown library ${name}`);
      for (const { start, length } of at) {
        hex = hex.slice(0, start * 2) + address + hex.slice((start + length) * 2);
        linked++;
      }
    }
  }
  if (linked === 0 || hex.includes('__$')) throw new Error('OwnedCensus is not fully linked');
  return `0x${hex}`;
}

/**
 * Whether `runtime` is the vendored `PoseidonT3`'s runtime code. A library
 * embeds its own address after the leading PUSH20, so that is left out.
 */
export function isPoseidonT3(runtime: string): boolean {
  if (!/^0x73[0-9a-fA-F]{40}/.test(runtime)) return false;
  const unaddressed = `0x73${'0'.repeat(40)}${runtime.slice(44)}`;
  return keccak256(unaddressed) === code.PoseidonT3.deployedBytecodeHash;
}

/** What {@link deployOwnedCensus} deployed. */
export interface DeployedCensus {
  /** The `OwnedCensus`, owned by the deployer. */
  address: string;
  /** The `PoseidonT3` it links. */
  poseidonT3: string;
  /** Whether `PoseidonT3` was deployed too (none at its usual address). */
  deployedLibrary: boolean;
}

/**
 * Deploys an `OwnedCensus` owned by `signer`, linked to the `PoseidonT3` at
 * its deterministic address when that holds the library, else to a fresh
 * one. `onTx` gets each deployment's label and transaction hash as it is sent.
 */
export async function deployOwnedCensus(
  signer: Signer,
  onTx: (label: string, hash: string) => void = () => undefined
): Promise<DeployedCensus> {
  const provider = signer.provider;
  if (!provider) throw new Error('deploying a census needs a signer with a provider');
  let library = POSEIDON_T3_ADDRESS;
  let deployedLibrary = false;
  if (!isPoseidonT3(await provider.getCode(library))) {
    library = await deploy(signer, [], code.PoseidonT3.bytecode, 'deploy PoseidonT3', onTx);
    deployedLibrary = true;
  }
  const address = await deploy(
    signer,
    OWNED_CENSUS_ABI,
    linkOwnedCensus(library),
    'deploy OwnedCensus',
    onTx
  );
  return { address, poseidonT3: library, deployedLibrary };
}

async function deploy(
  signer: Signer,
  abi: InterfaceAbi,
  bytecode: string,
  label: string,
  onTx: (label: string, hash: string) => void
): Promise<string> {
  const contract = await new ContractFactory(abi, bytecode, signer).deploy();
  const tx = contract.deploymentTransaction();
  if (tx) onTx(label, tx.hash);
  await contract.waitForDeployment();
  return getAddress(await contract.getAddress());
}
