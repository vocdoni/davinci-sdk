import { buildBallot, type BuiltBallot, type SnarkjsVerificationKey } from '../../src/crypto';
import { bigIntToHex } from '../../src/crypto/field';
import type { Groth16Proof } from '../../src/sequencer/types';
import { loadFixture, readFixture } from './fixtures';

// davinci-zkvm rust-sdk/testdata/real_proof.json: a 6-field ballot proved under the pinned
// (development) VK, with its 71 public signals.
interface RealProofJson {
  vk: SnarkjsVerificationKey;
  proof: Groth16Proof;
  public_signals: string[];
  ballot: {
    process_id: string;
    address: string;
    k: string;
    weight: string;
    mode: {
      num_fields: number;
      group_size: number;
      unique_values: boolean;
      cost_exponent: number;
      max_value: string | number;
      min_value: string | number;
      max_value_sum: string | number;
      min_value_sum: string | number;
    };
    fields: (string | number)[];
    pk: { x: string; y: string };
  };
}

export const REAL_PROOF = loadFixture<RealProofJson>('zkvm/real_proof.json');

/** The pinned verification key, byte for byte (davinci-circom e99127d, the dev setup). */
export const PINNED_VKEY_TEXT = readFixture('zkvm/ballot_proof_vkey.json');

/** A well-formed ballot key that is not the pinned one: its IC points 1 and 2 swapped. */
export const OTHER_VKEY: SnarkjsVerificationKey = (() => {
  const vk = JSON.parse(PINNED_VKEY_TEXT) as SnarkjsVerificationKey;
  [vk.IC[1], vk.IC[2]] = [vk.IC[2], vk.IC[1]];
  return vk;
})();

/** The pinned key without a phase-2 contribution: delta is gamma. */
export const NO_PHASE2_VKEY: SnarkjsVerificationKey = (() => {
  const vk = JSON.parse(PINNED_VKEY_TEXT) as SnarkjsVerificationKey;
  vk.vk_delta_2 = vk.vk_gamma_2;
  return vk;
})();

/** The ballot of the real proof, rebuilt with its secret `k`. */
export async function realProofBallot(
  overrides: { fields?: bigint[]; k?: bigint } = {}
): Promise<BuiltBallot> {
  const b = REAL_PROOF.ballot;
  return buildBallot({
    processId: bigIntToHex(BigInt(b.process_id), 31),
    address: `0x${b.address}`,
    encryptionKey: { x: BigInt(b.pk.x), y: BigInt(b.pk.y) },
    ballotMode: {
      numFields: b.mode.num_fields,
      groupSize: b.mode.group_size,
      uniqueValues: b.mode.unique_values,
      costExponent: b.mode.cost_exponent,
      maxValue: BigInt(b.mode.max_value),
      minValue: BigInt(b.mode.min_value),
      maxValueSum: BigInt(b.mode.max_value_sum),
      minValueSum: BigInt(b.mode.min_value_sum),
    },
    fields: overrides.fields ?? b.fields.map(BigInt),
    weight: BigInt(b.weight),
    k: overrides.k ?? BigInt(b.k),
  });
}
