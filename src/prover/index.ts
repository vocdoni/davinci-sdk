/**
 * Ballot proofs: the circuit files keyed by the registry's ballot VK hash,
 * downloaded and checked, and the snarkjs prover.
 */

export {
  type ArtifactCache,
  type ArtifactFile,
  type ArtifactName,
  type ArtifactSource,
  type ArtifactsConfig,
  type BallotArtifactSet,
  type BallotArtifacts,
  ARTIFACT_STALL_TIMEOUT_MS,
  BALLOT_ARTIFACTS,
  MemoryArtifactCache,
  ballotArtifactSet,
  checkArtifactsConfig,
  loadBallotArtifacts,
} from './artifacts';
export {
  type BallotProof,
  type BallotProverOptions,
  type ProvableBallot,
  BallotProver,
  verifyBallotProof,
} from './BallotProver';
export { ArtifactError, BallotProofError } from './errors';
