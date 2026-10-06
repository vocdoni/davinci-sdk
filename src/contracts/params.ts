/**
 * @fileoverview Builders for the registry's write arguments: the DKG and
 * Council key mode parameters and the metadata hash `newProcess` binds.
 */

import { sha256, toUtf8Bytes, zeroPadValue } from 'ethers';
import type { OrganizerProof } from '../crypto/dkg';
import { parseHexBytes } from '../crypto/field';
import { type DkgParams, KeyMode } from './types';

const ZERO_EPOCH = zeroPadValue('0x', 12);

/**
 * The registry's bound on a process's largest possible tally
 * (`ProcessRegistry.MAX_POSSIBLE_RESULT_CAP`, which keeps the results within
 * the decryption search): `maxValue` may not exceed `RESULT_CAP / maxVoters`
 * (integer division), at creation and on every `setProcessMaxVoters`, else
 * `MaxPossibleResultCapExceeded`.
 */
export const RESULT_CAP = 1_000_000_000_000n;

/** `DKGParams` of a SEQUENCER-key process: every field zero. */
export function sequencerKeyParams(): DkgParams {
  return {
    mode: KeyMode.Sequencer,
    epochId: ZERO_EPOCH,
    orgPKx: 0n,
    orgPKy: 0n,
    popAx: 0n,
    popAy: 0n,
    popZ: 0n,
  };
}

/** `DKGParams` of a DKG_AUTOMATIC process: only the mode; the adapter picks the epoch. */
export function dkgAutomaticParams(): DkgParams {
  return { ...sequencerKeyParams(), mode: KeyMode.DkgAutomatic };
}

/**
 * `DKGParams` of a DKG_LOCKED process: the registration epoch and the
 * organizer key with its proof of possession, as `proveOrganizerKey` returns
 * them for that epoch and the process's `aidFor`.
 *
 * @param epochId - `adapter.registrationEpoch()`, `bytes12` hex
 * @param proof - `proveOrganizerKey({ epochId, aid, secret })`
 *
 * @example
 * ```typescript
 * const epochId = await registry.getRegistrationEpoch();
 * const aid = await registry.aidFor(nextProcessId);
 * const secret = randomOrganizerSecret(); // keep it: results stay locked without it
 * const dkg = dkgLockedParams(epochId, proveOrganizerKey({ epochId, aid, secret }));
 * ```
 */
export function dkgLockedParams(epochId: string, proof: OrganizerProof): DkgParams {
  parseHexBytes(epochId, 12, 'epoch id');
  return {
    mode: KeyMode.DkgLocked,
    epochId: `0x${epochId.replace(/^0x/, '').toLowerCase()}`,
    orgPKx: proof.pkX,
    orgPKy: proof.pkY,
    popAx: proof.aX,
    popAy: proof.aY,
    popZ: proof.z,
  };
}

/**
 * `DKGParams` of a COUNCIL process: the ceremony id, nothing else. The
 * ceremony must be Live, and its organizer must have allowed the registry's
 * Council adapter and authorized the account that creates the process.
 *
 * @param ceremonyId - The Council ceremony, non-zero `bytes12` hex
 */
export function councilParams(ceremonyId: string): DkgParams {
  parseHexBytes(ceremonyId, 12, 'ceremony id');
  const id = `0x${ceremonyId.replace(/^0x/i, '').toLowerCase()}`;
  if (id === ZERO_EPOCH) throw new TypeError('the ceremony id is zero');
  return { ...sequencerKeyParams(), mode: KeyMode.Council, epochId: id };
}

/**
 * The `metadataHash` of a metadata document: SHA-256 of the exact bytes
 * served at its URI, with no JSON canonicalisation. A string is hashed as
 * UTF-8, so pass the bytes when the served file differs from the string.
 *
 * @returns `bytes32` hex
 */
export function metadataHash(document: string | Uint8Array): string {
  return sha256(typeof document === 'string' ? toUtf8Bytes(document) : document);
}
