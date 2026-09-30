/**
 * @fileoverview secp256k1 signatures of the protocol, as davinci-zkvm
 * `rust-sdk/src/census.rs` computes and checks them: the CSP census
 * attestation and the voter's signature over its vote id. Both are Ethereum
 * personal-sign (EIP-191) signatures, so an ethers `Signer` produces them.
 */

import {
  Signature,
  SigningKey,
  computeAddress,
  concat,
  getAddress,
  hashMessage,
  hexlify,
  type Signer,
} from 'ethers';
import { bigIntToBytes, bigIntToHex, bytesToBigInt, parseHexBytes } from './field';
import { slotFromCspIndex } from './census';
import { CENSUS_WEIGHT_BITS, VOTE_ID_MIN } from '../protocol/limits';

/** secp256k1 group order. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N >> 1n;

/** A secp256k1 signature with `v` as the recovery id (0 or 1). */
export interface EcdsaSignature {
  /** `0x` + 64 hex digits. */
  r: string;
  /** `0x` + 64 hex digits, low-S. */
  s: string;
  v: 0 | 1;
}

/** A CSP's attestation that `address` may vote with `weight` in slot `0x10 + index`. */
export interface CspAttestation {
  /** Voter address the CSP signed for. */
  address: string;
  weight: bigint;
  /** CSP-chosen index, unique per voter. */
  index: bigint;
  r: string;
  s: string;
  /** Recovery id, 0 or 1. */
  recid: 0 | 1;
}

/**
 * The 92-byte payload a CSP signs:
 * `pid_BE32 || address20 || weight_BE32 || index_BE8`, the weight as 16 zero
 * bytes and its u128 big-endian.
 */
export function cspAttestationMessage(
  processId: string,
  address: string,
  weight: bigint,
  index: bigint
): Uint8Array {
  if (weight < 0n || weight >= 1n << 128n) throw new RangeError('weight does not fit in a u128');
  if (index < 0n || index >= 1n << 64n) throw new RangeError('index does not fit in a u64');
  const out = new Uint8Array(92);
  out.set(parseHexBytes(processId, 31, 'process id'), 1);
  out.set(parseHexBytes(address, 20, 'address'), 32);
  out.set(bigIntToBytes(weight, 32), 52);
  out.set(bigIntToBytes(index, 8), 84);
  return out;
}

/** The personal-sign digest of a CSP attestation: `keccak("\x19Ethereum Signed Message:\n92" || payload)`. */
export function cspAttestationHash(
  processId: string,
  address: string,
  weight: bigint,
  index: bigint
): string {
  return hashMessage(cspAttestationMessage(processId, address, weight, index));
}

/** The 32-byte message a voter signs for its vote id: 24 zero bytes and the id's BE8. */
export function voteIdSignatureMessage(voteId: bigint): Uint8Array {
  if (voteId < 0n || voteId >= 1n << 64n) throw new RangeError('vote id does not fit in a u64');
  return bigIntToBytes(voteId, 32);
}

/** The personal-sign digest of a vote id. */
export function voteIdSignatureHash(voteId: bigint): string {
  return hashMessage(voteIdSignatureMessage(voteId));
}

// A signer's 65-byte signature as low-S (r, s, recid).
function normalize(hex: string): EcdsaSignature {
  const sig = decodeEcdsaSignature(hex);
  const s = BigInt(sig.s);
  if (s <= HALF_N) return sig;
  return { r: sig.r, s: bigIntToHex(SECP256K1_N - s), v: sig.v === 0 ? 1 : 0 };
}

function parseSignature(r: string, s: string, v: number): Signature {
  const rv = bytesToBigInt(parseHexBytes(r, 32, 'r'));
  const sv = bytesToBigInt(parseHexBytes(s, 32, 's'));
  if (rv === 0n || rv >= SECP256K1_N) throw new RangeError('r out of range');
  if (sv === 0n || sv >= SECP256K1_N) throw new RangeError('s out of range');
  if (sv > HALF_N) throw new RangeError('high-S signature');
  if (v !== 0 && v !== 1) throw new RangeError('recovery id not in {0, 1, 27, 28}');
  return Signature.from({ r: bigIntToHex(rv), s: bigIntToHex(sv), v: 27 + v });
}

function recover(digest: string, sig: Signature): string {
  return computeAddress(SigningKey.recoverPublicKey(digest, sig));
}

async function signChecked(signer: Signer, message: Uint8Array): Promise<EcdsaSignature> {
  const sig = normalize(await signer.signMessage(message));
  const signerAddress = await signer.getAddress();
  if (
    recover(hashMessage(message), parseSignature(sig.r, sig.s, sig.v)) !== getAddress(signerAddress)
  ) {
    throw new Error('signature does not recover to the signer');
  }
  return sig;
}

/** What a CSP attests for one voter. */
export interface CspAttestationParams {
  /** Process id, `0x` + 62 hex digits. */
  processId: string;
  /** Voter address. */
  address: string;
  /** Voter weight, below 2^88. */
  weight: bigint;
  /** CSP-chosen index, unique per voter; the voter's slot is `0x10 + index`. */
  index: bigint;
}

/**
 * Signs a CSP attestation with the CSP's key (its address is the census root).
 * The signature is low-S; with a `Wallet` it is deterministic (RFC 6979).
 */
export async function signCspAttestation(
  csp: Signer,
  p: CspAttestationParams
): Promise<CspAttestation> {
  if (p.weight < 0n || p.weight >> BigInt(CENSUS_WEIGHT_BITS) !== 0n) {
    throw new RangeError(`weight does not fit in ${CENSUS_WEIGHT_BITS} bits`);
  }
  slotFromCspIndex(p.index);
  const sig = await signChecked(
    csp,
    cspAttestationMessage(p.processId, p.address, p.weight, p.index)
  );
  return {
    address: getAddress(p.address),
    weight: p.weight,
    index: p.index,
    r: sig.r,
    s: sig.s,
    recid: sig.v,
  };
}

/**
 * Address of the CSP that signed an attestation: the census root of a CSP
 * process must be this address. Throws on a recovery id other than 0 or 1,
 * a high-S signature or out-of-range scalars.
 */
export function recoverCspSigner(processId: string, a: CspAttestation): string {
  const digest = cspAttestationHash(processId, a.address, a.weight, a.index);
  return recover(digest, parseSignature(a.r, a.s, a.recid));
}

/**
 * The voter's signature over its vote id (personal-sign of
 * {@link voteIdSignatureMessage}), low-S with `v` as the recovery id.
 */
export async function signVoteId(voter: Signer, voteId: bigint): Promise<EcdsaSignature> {
  if (voteId < VOTE_ID_MIN) throw new RangeError('vote id below 2^63');
  return signChecked(voter, voteIdSignatureMessage(voteId));
}

/**
 * Signer address of a vote-id signature. Accepts `v` in {0, 1, 27, 28} like
 * the sequencer, and rejects high-S.
 */
export function recoverVoteIdSigner(voteId: bigint, sig: EcdsaSignature | string): string {
  const { r, s, v } = typeof sig === 'string' ? decodeEcdsaSignature(sig) : sig;
  return recover(voteIdSignatureHash(voteId), parseSignature(r, s, v));
}

/** `r || s || v` as 65 bytes of `0x` hex, `v` the recovery id (the vote request's `signature`). */
export function encodeEcdsaSignature(sig: EcdsaSignature): string {
  return concat([
    parseHexBytes(sig.r, 32, 'r'),
    parseHexBytes(sig.s, 32, 's'),
    new Uint8Array([sig.v]),
  ]);
}

/** Inverse of {@link encodeEcdsaSignature}; `v` may be 0, 1, 27 or 28. */
export function decodeEcdsaSignature(hex: string): EcdsaSignature {
  const b = parseHexBytes(hex, 65, 'signature');
  const v = b[64] >= 27 ? b[64] - 27 : b[64];
  if (v !== 0 && v !== 1) throw new RangeError('recovery id not in {0, 1, 27, 28}');
  return { r: hexlify(b.slice(0, 32)), s: hexlify(b.slice(32, 64)), v };
}
