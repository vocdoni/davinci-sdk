/**
 * @fileoverview Errors of the sequencer HTTP client. A node answers every
 * failure with `{"error": "<message>", "code": <code>}`, the code being the
 * HTTP status times 100 plus a discriminator (davinci-sequencer
 * `sequencer/src/api/error.rs`).
 */

/** The `code` of a sequencer error answer. */
export enum SequencerErrorCode {
  /**
   * 400: malformed request or field. For a vote also an address outside the
   * census, a missing CSP proof or a vote for another process.
   */
  MalformedRequest = 40001,
  /** 400: the vote failed a protocol check (proof, signature, inputs hash, census binding, ballot, weight). */
  InvalidVote = 40002,
  /** 404: not found. */
  NotFound = 40401,
  /** 404: a process this node does not know or does not serve. */
  UnknownProcess = 40402,
  /**
   * 408: the node's 60 s deadline fired. The handler may still have finished:
   * a vote may have been admitted, and a retry then answers 40901.
   */
  RequestTimeout = 40801,
  /** 409: the vote id is already queued or in the tree. */
  DuplicateVote = 40901,
  /** 409: the voter's slot already holds the most queued votes; retry once one settles. */
  SlotBusy = 40902,
  /** 412: the process does not accept votes (ended, canceled or past its end). */
  NotAcceptingVotes = 41201,
  /** 412: max voters reached. */
  MaxVotersReached = 41202,
  /** 412: an observer node, which neither accepts votes nor issues keys. */
  ObserverNode = 41203,
  /** 412: the process's start time is ahead. */
  NotStarted = 41204,
  /** 413: body over 256 KiB. */
  BodyTooLarge = 41301,
  /** 429: `POST /processes/keys` per-minute limit. */
  KeyRateLimit = 42901,
  /** 429: the node is at capacity (or still loading the census); retry shortly. */
  Busy = 42903,
  /** 500: internal error; the detail stays in the node's log. */
  Internal = 50001,
}

/** Any failure talking to a sequencer node. */
export class SequencerError extends Error {
  /**
   * @param message - What went wrong
   * @param node - Base URL of the node, when known
   */
  constructor(
    message: string,
    public readonly node?: string
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** The node answered with an error status. */
export class SequencerApiError extends SequencerError {
  /**
   * @param message - The node's error text
   * @param status - HTTP status
   * @param code - The body's `code` ({@link SequencerErrorCode}); absent when the body is not the node's error shape
   * @param node - Base URL of the node
   */
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    node?: string
  ) {
    super(message, node);
  }
}

/** No usable answer: a network failure, the request timeout, an abort or an unreadable body. */
export class SequencerNetworkError extends SequencerError {
  /**
   * @param message - What failed
   * @param timedOut - The client-side timeout fired
   * @param cause - The underlying error
   * @param node - Base URL of the node
   */
  constructor(
    message: string,
    public readonly timedOut: boolean,
    public readonly cause?: unknown,
    node?: string
  ) {
    super(message, node);
  }
}

/** An answer that does not decode or does not check out (a key outside the subgroup, a proof for another vote). */
export class SequencerDecodeError extends SequencerError {}

/** True when `err` is a {@link SequencerApiError} with `code`. */
export function hasSequencerErrorCode(err: unknown, code: SequencerErrorCode): boolean {
  return err instanceof SequencerApiError && err.code === code;
}
