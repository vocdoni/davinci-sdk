import {
  BALLOT_VK_HASH,
  SnarkjsVerificationKey,
  ballotVkHash,
  ballotVkWireBytes,
} from '../../../src';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/{hashes,real_proof,real_proof_v1,genesis}.json and
// rust-sdk/assets/ballot_proof_vkey.json (davinci-circom artifacts/ballot_proof_vkey.json at a39a9f9).
interface Hashes {
  ballot_vk_leaf: string;
  ballot_vk_leaf_v1: string;
}

const clone = (vk: SnarkjsVerificationKey) =>
  JSON.parse(JSON.stringify(vk)) as SnarkjsVerificationKey;

// BN254 base field arithmetic, enough to build twist points for the subgroup test.
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
type Fq2 = [bigint, bigint];
const md = (x: bigint) => ((x % Q) + Q) % Q;
const mul2 = (a: Fq2, b: Fq2): Fq2 => [
  md(a[0] * b[0] - a[1] * b[1]),
  md(a[0] * b[1] + a[1] * b[0]),
];
const pow2 = (a: Fq2, e: bigint): Fq2 => {
  let out: Fq2 = [1n, 0n];
  let base = a;
  for (let x = e; x > 0n; x >>= 1n) {
    if (x & 1n) out = mul2(out, base);
    base = mul2(base, base);
  }
  return out;
};
const eq2 = (a: Fq2, b: Fq2) => a[0] === b[0] && a[1] === b[1];

// Square root in Fq2 for q = 3 mod 4 (Adj and Rodriguez-Henriquez, algorithm 9), or null.
function sqrt2(a: Fq2): Fq2 | null {
  const a1 = pow2(a, (Q - 3n) / 4n);
  const alpha = mul2(a1, mul2(a1, a));
  const a0 = mul2([alpha[0], md(-alpha[1])], alpha);
  if (eq2(a0, [Q - 1n, 0n])) return null;
  const x0 = mul2(a1, a);
  const x = eq2(alpha, [Q - 1n, 0n])
    ? mul2([0n, 1n], x0)
    : mul2(pow2([md(1n + alpha[0]), alpha[1]], (Q - 1n) / 2n), x0);
  return eq2(mul2(x, x), a) ? x : null;
}

// A point on the twist y^2 = x^3 + 3/(9+u) that is almost surely outside the order-r subgroup.
function twistPoint(): [Fq2, Fq2] {
  const b2: Fq2 = [
    19485874751759354771024239261021720505790618469301721065564631296452457478373n,
    266929791119991161246907387137283842545076965332900288569378510910307636690n,
  ];
  for (let k = 1n; ; k++) {
    const x: Fq2 = [k, 1n];
    const rhs = mul2(mul2(x, x), x);
    const y = sqrt2([md(rhs[0] + b2[0]), md(rhs[1] + b2[1])]);
    if (y) return [x, y];
  }
}

describe('ballot VK hash', () => {
  const hashes = loadFixture<Hashes>('zkvm/hashes.json');
  const pinned = loadFixture<SnarkjsVerificationKey>('zkvm/ballot_proof_vkey.json');

  it('hashes the pinned key to the registry pin and state leaf 0x07', () => {
    expect(ballotVkHash(pinned)).toBe(`0x${hashes.ballot_vk_leaf}`);
    expect(ballotVkHash(pinned)).toBe(BALLOT_VK_HASH);
    const real = loadFixture<{ vk: SnarkjsVerificationKey }>('zkvm/real_proof.json');
    expect(ballotVkHash(real.vk)).toBe(BALLOT_VK_HASH);
    for (const g of loadFixture<{ ballot_vk_hash: string }[]>('zkvm/genesis.json')) {
      expect(`0x${g.ballot_vk_hash}`).toBe(BALLOT_VK_HASH);
    }
  });

  it('tells the v1.0.0 key apart', () => {
    const v1 = loadFixture<{ vk: SnarkjsVerificationKey }>('zkvm/real_proof_v1.json');
    expect(ballotVkHash(v1.vk)).toBe(`0x${hashes.ballot_vk_leaf_v1}`);
    expect(ballotVkHash(v1.vk)).not.toBe(BALLOT_VK_HASH);
  });

  it('lays out the wire bytes: 64 + 3 x 128 + 8 + 4 x 64', () => {
    const wire = ballotVkWireBytes(pinned);
    expect(wire).toHaveLength(64 + 3 * 128 + 8 + 4 * 64);
    // alpha.x as LE32 first.
    const alphaX = BigInt(pinned.vk_alpha_1[0]);
    expect(Buffer.from(wire.slice(0, 32)).reverse().toString('hex')).toBe(
      alphaX.toString(16).padStart(64, '0')
    );
    expect(Array.from(wire.slice(448, 456))).toEqual([4, 0, 0, 0, 0, 0, 0, 0]);
    // Missing protocol and curve default to groth16/bn128, like the Rust parser.
    const bare = clone(pinned);
    delete bare.protocol;
    delete bare.curve;
    expect(ballotVkHash(bare)).toBe(BALLOT_VK_HASH);
  });

  it('writes an identity point as zeros', () => {
    const vk = clone(pinned);
    vk.IC[3] = ['1', '2', '0'];
    const wire = ballotVkWireBytes(vk);
    expect(wire.slice(wire.length - 64).every(b => b === 0)).toBe(true);
  });

  it('refuses keys the Rust parser refuses', () => {
    const fewer = clone(pinned);
    fewer.IC.pop();
    expect(() => ballotVkHash(fewer)).toThrow('IC points');
    const offCurve = clone(pinned);
    offCurve.vk_alpha_1[0] = '5';
    expect(() => ballotVkHash(offCurve)).toThrow('not on the curve');
    const offTwist = clone(pinned);
    offTwist.vk_beta_2[0][0] = '5';
    expect(() => ballotVkHash(offTwist)).toThrow('not on the curve');
    const big = clone(pinned);
    big.vk_alpha_1[0] =
      '21888242871839275222246405745257275088696311157297823662689037894645226208583';
    expect(() => ballotVkHash(big)).toThrow('base field');
    const hex = clone(pinned);
    hex.vk_alpha_1[0] = '0x05';
    expect(() => ballotVkHash(hex)).toThrow('decimal');
    expect(() => ballotVkHash({ ...clone(pinned), protocol: 'plonk' })).toThrow('groth16');
  });

  it('refuses a G2 point on the twist but outside the subgroup, like the Rust parser', () => {
    const [x, y] = twistPoint();
    const vk = clone(pinned);
    vk.vk_delta_2 = [[x[0], x[1]].map(String), [y[0], y[1]].map(String), ['1', '0']];
    expect(() => ballotVkHash(vk)).toThrow('not in the subgroup');
  });
});
