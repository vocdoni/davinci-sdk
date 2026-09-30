/**
 * Protocol cryptography of the zkVM stack: BabyJubJub and ElGamal, ballots
 * and their proof inputs, the Merkle census and slots, CSP and vote-id
 * signatures, tracker proofs, the ballot VK hash and the DKG organizer proof.
 * Every function computes byte for byte what the davinci-zkvm Rust SDK does.
 */

export { BN254_FR, addressToField, processIdToField } from './field';
export { poseidon, multiPoseidon } from './poseidon';
export {
  type BjjPoint,
  BJJ_B8,
  BJJ_IDENTITY,
  BJJ_SUBGROUP_ORDER,
  bjjAdd,
  bjjInSubgroup,
  bjjIsIdentity,
  bjjIsOnCurve,
  bjjMul,
  bjjMulBase,
  bjjNeg,
  isValidEncryptionKey,
  toBjjPoint,
} from './babyjubjub';
export {
  type ElGamalCiphertext,
  IDENTITY_CIPHERTEXT,
  elgamalEncrypt,
  isIdentityCiphertext,
  randomBallotSecret,
} from './encryption';
export {
  type Ballot,
  type BallotCircuitInputs,
  type BallotInputsHashParams,
  type BallotModeValues,
  type BuildBallotParams,
  type BuiltBallot,
  ballotCoords,
  ballotInputsHashPreimage,
  buildBallot,
  computeBallotInputsHash,
  computeVoteId,
  encryptBallot,
  isBallotPaddingValid,
  packBallotMode,
  unpackBallotMode,
} from './ballot';
export { type BallotCheckResult, checkBallot } from './ballotChecker';
export {
  type LeanIMTProof,
  LeanIMT,
  SLOT_TAG,
  censusLeaf,
  censusLeafAddress,
  censusLeafWeight,
  slotFromAddress,
  slotFromCspIndex,
  verifyLeanIMTProof,
} from './census';
export {
  type CspAttestation,
  type CspAttestationParams,
  type EcdsaSignature,
  cspAttestationHash,
  cspAttestationMessage,
  decodeEcdsaSignature,
  encodeEcdsaSignature,
  recoverCspSigner,
  recoverVoteIdSigner,
  signCspAttestation,
  signVoteId,
  voteIdSignatureHash,
  voteIdSignatureMessage,
} from './ecdsa';
export { type TrackerProof, verifyTrackerProof, voteIdLeafHash } from './tracker';
export {
  type SnarkjsVerificationKey,
  BALLOT_PROOF_PUBLIC_SIGNALS,
  ballotVkHash,
  ballotVkWireBytes,
} from './groth16';
export {
  type OrganizerProof,
  type OrganizerProofParams,
  ORGANIZER_REGISTER_DOMAIN,
  pointFromReducedTE,
  pointToReducedTE,
  proveOrganizerKey,
  randomOrganizerSecret,
} from './dkg';
