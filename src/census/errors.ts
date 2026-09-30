/**
 * @fileoverview Errors of the census module.
 */

/** Any census failure. */
export class CensusError extends Error {
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

/**
 * Two members of a Merkle census would share a ballot slot, and so overwrite
 * each other's ballots: nodes refuse such a census.
 */
export class CensusSlotCollisionError extends CensusError {
  /**
   * @param slot - The shared slot
   * @param addresses - The member already there and the one added
   */
  constructor(
    public readonly slot: bigint,
    public readonly addresses: readonly [string, string]
  ) {
    super(`ballot slot 0x${slot.toString(16)} is shared by ${addresses[0]} and ${addresses[1]}`);
  }
}

/**
 * A census file that could not be published: the upload failed, or the URL
 * does not serve what nodes would accept as that census.
 */
export class CensusPublishError extends CensusError {
  /**
   * @param message - What went wrong
   * @param uri - The URL the uploader returned, once there is one
   * @param cause - The underlying error
   */
  constructor(
    message: string,
    public readonly uri?: string,
    cause?: unknown
  ) {
    super(message, cause);
  }
}

/** A census witness that is not this voter's, or not for this process's census. */
export class CensusWitnessError extends CensusError {}
