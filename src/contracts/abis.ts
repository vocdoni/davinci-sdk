/**
 * @fileoverview Contract ABIs of the DAVINCI deployment the SDK targets.
 *
 * `abi/*.json` are the forge build ABIs of davinci-contracts at the commit in
 * `abi/source.json`, and `abi/census/*.json` those of
 * davinci-onchain-census-contract at the commit in `abi/census/source.json`,
 * both copied by `scripts/sync-abis.mjs`. Do not edit them by hand: re-run the
 * script and the drift test (`test/contracts/unit/abi.test.ts`).
 */

import { Interface, type BytesLike, type JsonFragment, type Result } from 'ethers';
import censusValidatorAbi from './abi/ICensusValidator.json';
import councilAdapterAbi from './abi/CouncilAdapter.json';
import councilManagerAbi from './abi/ICouncilManager.json';
import councilManagerErrorsAbi from './abi/ICouncilManagerErrors.json';
import dkgAdapterAbi from './abi/DavinciDKGAdapter.json';
import dkgAppManagerAbi from './abi/IDKGAppManager.json';
import dkgManagerAbi from './abi/IDKGManager.json';
import processRegistryAbi from './abi/ProcessRegistry.json';
import abiSource from './abi/source.json';
import ziskVerifierAbi from './abi/ZiskVerifier.json';
import onchainCensusAbi from './abi/census/OnchainCensus.json';
import ownedCensusAbi from './abi/census/OwnedCensus.json';
import censusAbiSource from './abi/census/source.json';

/** `ProcessRegistry`: processes, census, metadata, grace window, DKG and Council key modes. */
export const PROCESS_REGISTRY_ABI = processRegistryAbi as JsonFragment[];

/** `DavinciDKGAdapter`: the registry's bridge to the DKG committee (`registrationEpoch`, `aidFor`). */
export const DAVINCI_DKG_ADAPTER_ABI = dkgAdapterAbi as JsonFragment[];

/**
 * `CouncilAdapter`: the registry's bridge to a Council manager
 * (`bindings`, `plaintexts`, `manager`).
 */
export const COUNCIL_ADAPTER_ABI = councilAdapterAbi as JsonFragment[];

/**
 * Council `ICouncilManager` (the adapter's surface: `bindProcess`,
 * `submitRequest`, `getPlaintexts`, `getRequest`, `getBinding`,
 * `getPublicKey`), vendored verbatim by davinci-contracts.
 */
export const COUNCIL_MANAGER_ABI = councilManagerAbi as JsonFragment[];

/** The Council manager errors a registry call can bubble up (`ICouncilManagerErrors`). */
export const COUNCIL_MANAGER_ERRORS_ABI = councilManagerErrorsAbi as JsonFragment[];

/** `ZiskVerifier`: the PLONK verifier the registry calls (`getRootCVadcopFinal`). */
export const ZISK_VERIFIER_ABI = ziskVerifierAbi as JsonFragment[];

/** `ICensusValidator`: what an on-chain census contract exposes to the registry. */
export const CENSUS_VALIDATOR_ABI = censusValidatorAbi as JsonFragment[];

/** davinci-dkg `IDKGAppManager`, as vendored by davinci-contracts. */
export const DKG_APP_MANAGER_ABI = dkgAppManagerAbi as JsonFragment[];

/** davinci-dkg `IDKGManager`, as vendored by davinci-contracts. */
export const DKG_MANAGER_ABI = dkgManagerAbi as JsonFragment[];

/** davinci-contracts commit the vendored ABIs were built from. */
export const CONTRACTS_ABI_COMMIT: string = abiSource.commit;

/**
 * davinci-onchain-census-contract `OnchainCensus`: the
 * append-only lean-IMT census an origin-3 process points at, with
 * `ICensusValidator`, member weights, ballot slots and `CensusMemberAdded`.
 */
export const ONCHAIN_CENSUS_ABI = onchainCensusAbi as JsonFragment[];

/** `OwnedCensus`: an `OnchainCensus` whose owner adds members (`addMember`, `addMembers`). */
export const OWNED_CENSUS_ABI = ownedCensusAbi as JsonFragment[];

/** davinci-onchain-census-contract commit the vendored census ABIs were built from. */
export const CENSUS_CONTRACTS_ABI_COMMIT: string = censusAbiSource.commit;

/**
 * Every custom error a registry call can revert with, one fragment per
 * selector. Adapter, DKG and verifier errors bubble up through the registry
 * without being in its ABI, so a revert has to be decoded against all of them.
 */
export const DAVINCI_ERRORS_ABI: JsonFragment[] = (() => {
  const seen = new Set<string>();
  const out: JsonFragment[] = [];
  const sources = [
    PROCESS_REGISTRY_ABI,
    DAVINCI_DKG_ADAPTER_ABI,
    ZISK_VERIFIER_ABI,
    DKG_APP_MANAGER_ABI,
    DKG_MANAGER_ABI,
    COUNCIL_ADAPTER_ABI,
    COUNCIL_MANAGER_ERRORS_ABI,
  ];
  for (const abi of sources) {
    const iface = new Interface(abi);
    iface.forEachError(e => {
      if (seen.has(e.selector)) return;
      seen.add(e.selector);
      out.push(JSON.parse(e.format('json')) as JsonFragment);
    });
  }
  return out;
})();

/** A decoded DAVINCI custom error. */
export interface DavinciErrorDescription {
  /** Error name, e.g. `InvalidStatus`. */
  name: string;
  /** Full signature, e.g. `MissingBlob(uint256)`. */
  signature: string;
  /** 4-byte selector as `0x` hex. */
  selector: string;
  /** Decoded arguments. */
  args: Result;
}

let errorsInterface: Interface | undefined;

/**
 * Names a revert from its data against {@link DAVINCI_ERRORS_ABI}.
 *
 * @param data - Revert data (selector and ABI-encoded arguments)
 * @returns The decoded error, or null when the selector is not a DAVINCI error
 *
 * @example
 * ```typescript
 * decodeDavinciError('0xf525e320')?.name; // 'InvalidStatus'
 * ```
 */
export function decodeDavinciError(data: BytesLike): DavinciErrorDescription | null {
  errorsInterface ??= new Interface(DAVINCI_ERRORS_ABI);
  let parsed;
  try {
    parsed = errorsInterface.parseError(data);
  } catch {
    return null;
  }
  if (!parsed) return null;
  return {
    name: parsed.name,
    signature: parsed.signature,
    selector: parsed.selector,
    args: parsed.args,
  };
}
