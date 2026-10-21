/**
 * @fileoverview Ballot proofs with snarkjs: the Groth16 proof of a built
 * ballot on the `BallotProof(16)` circuit, under the ballot VK the registry
 * pins, checked like davinci-sequencer `Voter::build_vote` checks it.
 */

import * as snarkjs from 'snarkjs';
import type { BuiltBallot } from '../crypto/ballot';
import {
  BALLOT_PROOF_PUBLIC_SIGNALS,
  ballotVkWireBytes,
  type SnarkjsVerificationKey,
} from '../crypto/groth16';
import type { Groth16Proof } from '../sequencer/types';
import {
  checkArtifactsConfig,
  loadBallotArtifacts,
  normalizeHash,
  type ArtifactsConfig,
  type BallotArtifacts,
} from './artifacts';
import { BallotProofError } from './errors';

/** Options of a {@link BallotProver}. */
export interface BallotProverOptions {
  /** Where the circuit files come from; default the table URLs. */
  artifacts?: ArtifactsConfig;
  /** Verify every proof with the checked verification key before returning it; default true. */
  verifyProof?: boolean;
}

/** A ballot proof and what it proves: its 71 public signals as decimal strings. */
export interface BallotProof {
  proof: Groth16Proof;
  publicSignals: string[];
}

/** What the prover needs of a built ballot (`buildBallot`). */
export type ProvableBallot = Pick<BuiltBallot, 'circuitInputs' | 'publicSignals'>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const BN254_FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// What the node's parser takes: decimal coordinates below the base field
// modulus (snarkjs would reduce larger ones), no identity point, groth16/bn128.
function canonicalProof(p: Groth16Proof): boolean {
  const coord = (v: unknown) =>
    typeof v === 'string' && /^[0-9]{1,80}$/.test(v) && BigInt(v) < BN254_FQ;
  const g1 = (v: unknown) =>
    Array.isArray(v) && v.length === 3 && v[2] !== '0' && coord(v[0]) && coord(v[1]);
  const g2 = (v: unknown) => {
    if (!Array.isArray(v) || v.length !== 3) return false;
    const pairs = v as unknown[];
    if (!pairs.every(c => Array.isArray(c) && c.length === 2)) return false;
    const [x, y, z] = pairs as [string, string][];
    return (
      !(z[0] === '0' && z[1] === '0') && coord(x[0]) && coord(x[1]) && coord(y[0]) && coord(y[1])
    );
  };
  return (
    (p.protocol ?? 'groth16') === 'groth16' &&
    (p.curve ?? 'bn128') === 'bn128' &&
    g1(p.pi_a) &&
    g2(p.pi_b) &&
    g1(p.pi_c)
  );
}

/**
 * Verifies a ballot proof under `vkey`. Trust the answer only for a key
 * whose `ballotVkHash` equals the registry's `ballotVKHash()`, as the keys a
 * {@link BallotProver} loads do.
 *
 * @returns false for a proof that does not verify or does not parse (a coordinate
 *   at or above the base field modulus, an identity point), other
 *   than 71 public signals, or a key `ballotVkHash` refuses (other than 72 IC
 *   points, `delta == gamma`, a point off its curve)
 */
export async function verifyBallotProof(
  vkey: SnarkjsVerificationKey,
  proof: Groth16Proof,
  publicSignals: readonly (string | bigint)[]
): Promise<boolean> {
  if (publicSignals.length !== BALLOT_PROOF_PUBLIC_SIGNALS) return false;
  if (!canonicalProof(proof)) return false;
  try {
    ballotVkWireBytes(vkey);
    return await snarkjs.groth16.verify(vkey, publicSignals.map(String), proof);
  } catch {
    return false;
  }
}

/**
 * Proves built ballots. The circuit files of each ballot VK are downloaded
 * once and checked (sha256, and the verification keys against the registry's
 * ballot VK hash), then kept for the prover's lifetime. A proof must carry
 * exactly the ballot's public signals, and with `verifyProof` it must verify.
 *
 * In Node, snarkjs keeps worker threads alive after proving or verifying;
 * call {@link BallotProver.terminate} once done so the process can exit.
 *
 * @example
 * ```typescript
 * const prover = new BallotProver();
 * const built = await buildBallot({ processId, address, encryptionKey, ballotMode, fields, weight, k });
 * const { proof } = await prover.prove(built, await registry.getBallotVKHash());
 * ```
 */
export class BallotProver {
  private readonly config: ArtifactsConfig;
  private readonly verifyProofs: boolean;
  private readonly loaded = new Map<string, Promise<BallotArtifacts>>();

  /** @throws ArtifactError for a malformed `artifacts` table or timeout */
  constructor(options: BallotProverOptions = {}) {
    checkArtifactsConfig(options.artifacts);
    this.config = { ...options.artifacts };
    this.verifyProofs = options.verifyProof ?? true;
  }

  /**
   * The checked circuit files of `ballotVkHash`, loaded on first use. A load
   * that fails is tried again on the next call.
   *
   * @throws ArtifactError when the files are unknown, unreadable or not the pinned ones
   */
  load(ballotVkHash: string): Promise<BallotArtifacts> {
    const key = normalizeHash(ballotVkHash);
    let files = this.loaded.get(key);
    if (!files) {
      files = loadBallotArtifacts(key, this.config);
      this.loaded.set(key, files);
      files.catch(() => this.loaded.delete(key));
    }
    return files;
  }

  /**
   * Proves a built ballot under the ballot VK `ballotVkHash` (the registry's
   * `ballotVKHash()`).
   *
   * @throws ArtifactError when the circuit files cannot be had
   * @throws BallotProofError when the circuit refuses the inputs (choices
   *   outside the ballot mode), the proof carries other public signals than
   *   the ballot's, or it does not verify
   */
  async prove(ballot: ProvableBallot, ballotVkHash: string): Promise<BallotProof> {
    const files = await this.load(ballotVkHash);
    let out: Awaited<ReturnType<typeof snarkjs.groth16.fullProve>>;
    try {
      out = await snarkjs.groth16.fullProve(ballot.circuitInputs, files.wasm, files.zkey);
    } catch (err) {
      throw new BallotProofError(`the ballot circuit refused the inputs: ${message(err)}`, err);
    }
    const want = ballot.publicSignals.map(String);
    const got = out.publicSignals;
    if (got.length !== want.length || got.some((s, i) => s !== want[i])) {
      throw new BallotProofError(
        `the proof's public signals [${got.join(', ')}] are not the ballot's [${want.join(', ')}]`
      );
    }
    const proof = groth16Proof(out.proof);
    if (this.verifyProofs && !(await verifyBallotProof(files.vkey, proof, got))) {
      throw new BallotProofError('the ballot proof does not verify');
    }
    return { proof, publicSignals: want };
  }

  /**
   * Stops the worker threads snarkjs keeps after proving or verifying, so a
   * Node process can exit. Proving again starts them anew. Browsers need no
   * call.
   */
  static async terminate(): Promise<void> {
    const cached = (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null })
      .curve_bn128;
    await cached?.terminate();
  }
}

// snarkjs' proof in the shape the vote request carries.
function groth16Proof(p: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}): Groth16Proof {
  const three = (v: string[], what: string): [string, string, string] => {
    if (v.length !== 3) throw new BallotProofError(`the proof's ${what} is not a point`);
    return [v[0], v[1], v[2]];
  };
  const pair = (v: string[]): [string, string] => {
    if (v.length !== 2) throw new BallotProofError("the proof's pi_b is not a point");
    return [v[0], v[1]];
  };
  if (p.pi_b.length !== 3) throw new BallotProofError("the proof's pi_b is not a point");
  return {
    pi_a: three(p.pi_a, 'pi_a'),
    pi_b: [pair(p.pi_b[0]), pair(p.pi_b[1]), pair(p.pi_b[2])],
    pi_c: three(p.pi_c, 'pi_c'),
    protocol: p.protocol,
    curve: p.curve,
  };
}
