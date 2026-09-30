import type { ArtifactName } from './artifacts';

/**
 * A ballot circuit file that cannot be read, or is not the file the ballot VK
 * needs: no table entry for the key, a failed download, a sha256 that
 * differs from the pinned one, or a verification key that is not the key the
 * registry pins.
 */
export class ArtifactError extends Error {
  /**
   * @param message - What went wrong
   * @param file - The file concerned, when one is
   * @param cause - The underlying error
   */
  constructor(
    message: string,
    public readonly file?: ArtifactName,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * A ballot proof that could not be produced (the circuit refused the inputs),
 * that proves other public signals than the ballot's, or that does not
 * verify.
 */
export class BallotProofError extends Error {
  /**
   * @param message - What went wrong
   * @param cause - The underlying error
   */
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
