/**
 * @fileoverview The ballot proof verification key hash: sha256 of the VK wire
 * bytes, as davinci-zkvm `rust-sdk/src/groth16.rs` (and the guest's
 * `hash_vk_bytes`) compute it. The registry pins it as `ballotVKHash()`.
 */

import { concat, getBytes, sha256 } from 'ethers';
import { BN254_FR, bigIntToBytes } from './field';

/** A snarkjs Groth16 `verification_key.json`. */
export interface SnarkjsVerificationKey {
  protocol?: string;
  curve?: string;
  nPublic?: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  IC: string[][];
  vk_alphabeta_12?: unknown;
}

/** Public signals of the ballot proof: `[address, voteId, inputsHash]`. */
export const BALLOT_PROOF_PUBLIC_SIGNALS = 3;

// BN254 base field and the twist coefficient b' = 3 / (9 + u).
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const B2: Fq2 = [
  19485874751759354771024239261021720505790618469301721065564631296452457478373n,
  266929791119991161246907387137283842545076965332900288569378510910307636690n,
];

type Fq2 = [bigint, bigint];

const fq = (x: bigint) => ((x % Q) + Q) % Q;
const add2 = (a: Fq2, b: Fq2): Fq2 => [fq(a[0] + b[0]), fq(a[1] + b[1])];
const sub2 = (a: Fq2, b: Fq2): Fq2 => [fq(a[0] - b[0]), fq(a[1] - b[1])];
const mul2 = (a: Fq2, b: Fq2): Fq2 => [
  fq(a[0] * b[0] - a[1] * b[1]),
  fq(a[0] * b[1] + a[1] * b[0]),
];
const small2 = (k: bigint, a: Fq2): Fq2 => [fq(k * a[0]), fq(k * a[1])];
const isZero2 = (a: Fq2) => a[0] === 0n && a[1] === 0n;

// Jacobian point on the twist y^2 = x^3 + b' (a = 0); Z = 0 is infinity.
type G2Jac = [Fq2, Fq2, Fq2];

// dbl-2009-l.
function g2Double([x, y, z]: G2Jac): G2Jac {
  const a = mul2(x, x);
  const b = mul2(y, y);
  const c = mul2(b, b);
  const xb = add2(x, b);
  const d = small2(2n, sub2(sub2(mul2(xb, xb), a), c));
  const e = small2(3n, a);
  const x3 = sub2(mul2(e, e), small2(2n, d));
  const y3 = sub2(mul2(e, sub2(d, x3)), small2(8n, c));
  return [x3, y3, small2(2n, mul2(y, z))];
}

// madd-2007-bl: Jacobian plus affine (x2, y2).
function g2AddAffine(p: G2Jac, x2: Fq2, y2: Fq2): G2Jac {
  const [x1, y1, z1] = p;
  if (isZero2(z1)) return [x2, y2, [1n, 0n]];
  const z1z1 = mul2(z1, z1);
  const u2 = mul2(x2, z1z1);
  const s2 = mul2(mul2(y2, z1), z1z1);
  const h = sub2(u2, x1);
  const r = small2(2n, sub2(s2, y1));
  if (isZero2(h))
    return isZero2(r)
      ? g2Double(p)
      : [
          [1n, 0n],
          [1n, 0n],
          [0n, 0n],
        ];
  const hh = mul2(h, h);
  const i = small2(4n, hh);
  const j = mul2(h, i);
  const v = mul2(x1, i);
  const x3 = sub2(sub2(mul2(r, r), j), small2(2n, v));
  const y3 = sub2(mul2(r, sub2(v, x3)), small2(2n, mul2(y1, j)));
  const z1h = add2(z1, h);
  return [x3, y3, sub2(sub2(mul2(z1h, z1h), z1z1), hh)];
}

// r * P == O, r the BN254 group order: the G2 subgroup check.
function g2InSubgroup(x: Fq2, y: Fq2): boolean {
  let acc: G2Jac = [
    [1n, 0n],
    [1n, 0n],
    [0n, 0n],
  ];
  for (const bit of BN254_FR.toString(2)) {
    acc = g2Double(acc);
    if (bit === '1') acc = g2AddAffine(acc, x, y);
  }
  return isZero2(acc[2]);
}

function coordinate(s: unknown): bigint {
  if (typeof s !== 'string' || !/^[0-9]{1,80}$/.test(s)) {
    throw new TypeError('VK coordinate is not a decimal string');
  }
  const v = BigInt(s);
  if (v >= Q) throw new RangeError('VK coordinate is not below the base field modulus');
  return v;
}

function le32(x: bigint): Uint8Array {
  return bigIntToBytes(x, 32).reverse();
}

// snarkjs G1 `[x, y, z]`: identity when z is "0", else (x, y) affine.
function g1(v: string[]): Uint8Array {
  if (!Array.isArray(v) || v.length !== 3) throw new TypeError('G1 point needs 3 coordinates');
  if (v[2] === '0') return new Uint8Array(64);
  const [x, y] = [coordinate(v[0]), coordinate(v[1])];
  if (fq(y * y) !== fq(x * x * x + 3n)) throw new RangeError('G1 point is not on the curve');
  return getBytes(concat([le32(x), le32(y)]));
}

// snarkjs G2 `[[x.c0, x.c1], [y.c0, y.c1], z]`: identity when z is ["0", "0"].
function g2(v: string[][]): Uint8Array {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(c => Array.isArray(c) && c.length === 2)) {
    throw new TypeError('G2 point needs 3 pairs of coordinates');
  }
  if (v[2][0] === '0' && v[2][1] === '0') return new Uint8Array(128);
  const x: Fq2 = [coordinate(v[0][0]), coordinate(v[0][1])];
  const y: Fq2 = [coordinate(v[1][0]), coordinate(v[1][1])];
  const lhs = mul2(y, y);
  const rhs = add2(mul2(mul2(x, x), x), B2);
  if (lhs[0] !== rhs[0] || lhs[1] !== rhs[1]) throw new RangeError('G2 point is not on the curve');
  if (!g2InSubgroup(x, y)) throw new RangeError('G2 point is not in the subgroup');
  return getBytes(concat([le32(x[0]), le32(x[1]), le32(y[0]), le32(y[1])]));
}

/**
 * The VK wire bytes: alpha (G1: x, y as LE32), beta, gamma, delta (G2: x.c0,
 * x.c1, y.c0, y.c1, each LE32), the IC count as a u64 LE, then each IC point
 * (G1). An identity point is all zeros. The key must be Groth16 over bn128
 * with 3 public inputs, and every point must be canonical, on its curve and
 * in its prime-order subgroup: the keys the Rust parser accepts.
 */
export function ballotVkWireBytes(vk: SnarkjsVerificationKey): Uint8Array {
  if ((vk.protocol ?? 'groth16') !== 'groth16' || (vk.curve ?? 'bn128') !== 'bn128') {
    throw new TypeError('vk is not groth16/bn128');
  }
  if (!Array.isArray(vk.IC) || vk.IC.length !== BALLOT_PROOF_PUBLIC_SIGNALS + 1) {
    throw new RangeError(`vk has ${vk.IC?.length} IC points, want 4`);
  }
  const count = new Uint8Array(8);
  count[0] = vk.IC.length;
  return getBytes(
    concat([
      g1(vk.vk_alpha_1),
      g2(vk.vk_beta_2),
      g2(vk.vk_gamma_2),
      g2(vk.vk_delta_2),
      count,
      ...vk.IC.map(g1),
    ])
  );
}

/**
 * sha256 of {@link ballotVkWireBytes}, as `0x` hex: the registry's
 * `ballotVKHash()` and state leaf 0x07 (read big-endian). Throws for a key the
 * Rust parser refuses. A well-formed key is not a trusted one: trust it only
 * when its hash equals the registry's `ballotVKHash()`.
 *
 * @example
 * ```typescript
 * if (ballotVkHash(vkey) !== await registry.ballotVKHash()) throw new Error('wrong ballot key');
 * ```
 */
export function ballotVkHash(vk: SnarkjsVerificationKey): string {
  return sha256(ballotVkWireBytes(vk));
}
