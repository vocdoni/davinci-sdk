/**
 * @fileoverview BN254 scalar field (the BabyJubJub base field) and the byte
 * encodings the protocol uses for its elements.
 */

import { getBytes, hexlify, isHexString } from 'ethers';

/** BN254 scalar field modulus `p`: the BabyJubJub base field and the circuit field. */
export const BN254_FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Non-negative remainder of `a mod m`. */
export function mod(a: bigint, m: bigint = BN254_FR): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** `a^e mod m` by square and multiply. */
export function modPow(a: bigint, e: bigint, m: bigint = BN254_FR): bigint {
  let base = mod(a, m);
  let exp = e;
  let out = 1n;
  while (exp > 0n) {
    if (exp & 1n) out = (out * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return out;
}

/** Inverse of `a` mod a prime `m`; throws for zero. */
export function modInverse(a: bigint, m: bigint = BN254_FR): bigint {
  const x = mod(a, m);
  if (x === 0n) throw new RangeError('zero has no inverse');
  return modPow(x, m - 2n, m);
}

/** Throws unless `x` is a canonical field element (`0 <= x < p`). */
export function assertFieldElement(x: bigint, what = 'value'): bigint {
  if (x < 0n || x >= BN254_FR) throw new RangeError(`${what} is not a field element below p`);
  return x;
}

/** Big-endian integer of a byte string. */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(hexlify(bytes));
}

/** `x` as exactly `length` big-endian bytes; throws if it does not fit. */
export function bigIntToBytes(x: bigint, length = 32): Uint8Array {
  if (x < 0n || x >= 1n << BigInt(8 * length)) {
    throw new RangeError(`value does not fit in ${length} bytes`);
  }
  const out = new Uint8Array(length);
  let v = x;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** `x` as `0x` + exactly `2 * length` lowercase hex digits (big-endian). */
export function bigIntToHex(x: bigint, length = 32): string {
  return hexlify(bigIntToBytes(x, length));
}

/** Parses `0x`-optional hex of exactly `length` bytes. */
export function parseHexBytes(value: string, length: number, what = 'value'): Uint8Array {
  const hex = value.startsWith('0x') || value.startsWith('0X') ? value : `0x${value}`;
  if (!isHexString(hex, length)) throw new TypeError(`${what} must be ${length} bytes of hex`);
  return getBytes(hex);
}

/**
 * An Ethereum address as a field element: its 20 bytes read big-endian
 * (davinci-zkvm `ballot::address_to_fr`). Case and checksum are ignored.
 */
export function addressToField(address: string): bigint {
  return bytesToBigInt(parseHexBytes(address, 20, 'address'));
}

/**
 * A process id (`bytes31`, `0x` + 62 hex digits) as a field element: its 31
 * bytes read big-endian (davinci-sequencer `ProcessId::to_fr`).
 */
export function processIdToField(processId: string): bigint {
  return bytesToBigInt(parseHexBytes(processId, 31, 'process id'));
}
