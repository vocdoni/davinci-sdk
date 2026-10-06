/**
 * @fileoverview The registry's enums and structs as the SDK decodes them, its
 * events, and the callbacks of the event listeners.
 */

import type { BjjPoint } from '../crypto/babyjubjub';
import type { BallotModeValues } from '../crypto/ballot';
import type { CensusOrigin } from '../census/types';

/** `DAVINCITypes.ProcessStatus`. */
export enum ProcessStatus {
  READY = 0,
  ENDED = 1,
  CANCELED = 2,
  PAUSED = 3,
  RESULTS = 4,
}

/**
 * `DAVINCITypes.KeyMode`: where a process's election key comes from. The
 * DKG application's own mode enum runs the other way round; only this one
 * reaches the registry.
 */
export enum KeyMode {
  /** A sequencer's key (`POST /processes/keys`); only that node can publish the results. */
  Sequencer = 0,
  /** A davinci-dkg committee pool key; the committee decrypts the final tally. */
  DkgAutomatic = 1,
  /** A pool key plus an organizer key: nothing is decrypted until `revealProcessKey`. */
  DkgLocked = 2,
  /**
   * The key of a Live Council ceremony (invite-only threshold DKG); its
   * committee decrypts the final tally. Every process bound to a ceremony
   * shares its key.
   */
  Council = 3,
}

/** `DAVINCITypes.DKGParams`: all zero in SEQUENCER mode. */
export interface DkgParams {
  mode: KeyMode;
  /**
   * `bytes12` hex: the epoch a locked process registers in, or the ceremony
   * of a COUNCIL process; zero otherwise.
   */
  epochId: string;
  /** Organizer key and proof of possession, reduced TE (DKG_LOCKED only). */
  orgPKx: bigint;
  orgPKy: bigint;
  popAx: bigint;
  popAy: bigint;
  popZ: bigint;
}

/** A process census as `newProcess` and `setProcessCensus` take it. */
export interface RegistryCensus {
  origin: CensusOrigin;
  /**
   * Big-endian integer as `bytes32` hex, or the integer: the lean-IMT root,
   * or the CSP address. For an on-chain census the registry reads the root
   * from the contract, so zero is fine.
   */
  root: string | bigint;
  /** The census contract for origin 3; zero (the default) for every other origin. */
  contractAddress?: string;
  /** Where nodes download the census (Merkle) or voters get attestations (CSP); never empty. */
  uri: string;
}

/** `newProcess` arguments. */
export interface NewProcessParams {
  /** READY (default) or PAUSED. */
  status?: ProcessStatus.READY | ProcessStatus.PAUSED;
  /** Unix seconds; 0 means the block time. */
  startTime: bigint | number;
  /** Seconds. */
  duration: bigint | number;
  maxVoters: bigint | number;
  ballotMode: BallotModeValues;
  census: RegistryCensus;
  /** Where the metadata document is served; never empty. */
  metadataUri: string;
  /** SHA-256 of the exact bytes served at `metadataUri` (see `metadataHash`). */
  metadataHash: string;
  /** The sequencer's key in SEQUENCER mode; omitted (0, 0) in the DKG modes. */
  encryptionKey?: BjjPoint;
  /** Key mode and DKG arguments; SEQUENCER when omitted. */
  dkg?: DkgParams;
}

/**
 * DKG side of a process (key mode other than SEQUENCER): a davinci-dkg
 * application, or for COUNCIL a Council ceremony binding.
 */
export interface OnchainDkg {
  /** DKG_LOCKED rather than DKG_AUTOMATIC. */
  locked: boolean;
  /**
   * COUNCIL: `epochId` is the ceremony id, `aid` the request id, and the
   * registry's Council adapter (not the DKG adapter) holds the results.
   */
  council: boolean;
  /** `bytes12` hex: the DKG epoch, or the Council ceremony id. */
  epochId: string;
  /** Application id, or the Council request id; `bytes32` hex. */
  aid: string;
  /** `requestResultsDecryption` ran. */
  resultsRequested: boolean;
  /** DKG index of the first submitted ciphertext (always 0 for COUNCIL). */
  firstIndex: number;
  /** Ciphertexts submitted (identity fields are skipped). */
  count: number;
  /** Fields recorded as 0 without the DKG, bit i = field i. */
  zeroSkipped: number;
}

/**
 * The decryption gate of a COUNCIL process's ceremony (Council protocol
 * §8.7), as the registry reads it through its Council adapter. The committee
 * decrypts nothing and the registry publishes no result, not even an all-zero
 * tally, until it is open; once open it stays open, for every process bound
 * to the ceremony. A policy, not a time lock: enough colluding members can
 * always decrypt off chain earlier.
 *
 * While closed: `scheduled` opens by itself at `opensAt`; `manual` opens when
 * the ceremony's organizer opens it, or by itself at `opensAt` (the fallback
 * date) when the ceremony set one, else `opensAt` is null.
 */
export type CouncilDecryptionGate =
  | { open: true }
  | { open: false; mode: 'scheduled' | 'manual'; opensAt: bigint | null };

/**
 * A process as the registry stores it (`getProcess`). This, not a
 * sequencer's view, is what voters build ballots from.
 */
export interface OnchainProcess {
  /** `0x` + 62 hex digits. */
  processId: string;
  status: ProcessStatus;
  organizationId: string;
  encryptionKey: BjjPoint;
  /** Raw arbo root, `bytes32` hex. */
  latestStateRoot: string;
  /** `numFields` entries once RESULTS, else empty. */
  result: bigint[];
  /** Unix seconds. */
  startTime: bigint;
  /** Seconds. */
  duration: bigint;
  maxVoters: bigint;
  /** Distinct ballot slots written. */
  votersCount: bigint;
  overwrittenVotesCount: bigint;
  creationBlock: bigint;
  batchNumber: bigint;
  metadataUri: string;
  /** SHA-256 of the exact bytes served at `metadataUri`, `bytes32` hex. */
  metadataHash: string;
  ballotMode: BallotModeValues;
  census: {
    origin: CensusOrigin;
    /** `bytes32` hex. */
    root: string;
    contractAddress: string;
    uri: string;
  };
  keyMode: KeyMode;
  /** Absent for a SEQUENCER process. */
  dkg?: OnchainDkg;
  /** Idle seconds that close the grace window after the end. */
  grace: number;
  /** Block time of the latest transition; 0 before the first. */
  lastVoteAt: bigint;
}

/** The registry's grace window immutables, in seconds. */
export interface GraceParams {
  /** Grace window of a new process. */
  defaultGrace: number;
  /** `setProcessGrace` bounds. */
  graceFloor: number;
  graceCeil: number;
  /** The window never closes later than end + this. */
  graceMaxTotal: number;
  /** Least notice a shortened end gives. */
  noticeMin: number;
}

/** What `verifyDeployment` found. */
export interface DeploymentInfo {
  chainId: bigint;
  /** The `ZiskVerifier` the registry calls. */
  verifier: string;
  /** The registry's DKG adapter; null when the DKG key modes are disabled. */
  dkgAdapter: string | null;
  /**
   * The registry's Council adapter; null when the COUNCIL mode is disabled
   * or the registry predates it.
   */
  councilAdapter: string | null;
}

/** Where a registry event was logged. */
export interface RegistryEventLog {
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

/** A registry event, decoded. */
export type RegistryEvent = RegistryEventLog &
  (
    | { name: 'ProcessCreated'; processId: string; creator: string }
    | {
        name: 'ProcessStatusChanged';
        processId: string;
        oldStatus: ProcessStatus;
        newStatus: ProcessStatus;
      }
    | { name: 'CensusUpdated'; processId: string; censusRoot: string; censusUri: string }
    | {
        name: 'ProcessMetadataUpdated';
        processId: string;
        metadataUri: string;
        metadataHash: string;
      }
    | { name: 'ProcessDurationChanged'; processId: string; duration: bigint }
    | { name: 'ProcessMaxVotersChanged'; processId: string; maxVoters: bigint }
    | { name: 'ProcessGraceChanged'; processId: string; grace: number }
    | {
        name: 'ProcessStateTransitioned';
        processId: string;
        sender: string;
        oldStateRoot: string;
        newStateRoot: string;
        votersCount: bigint;
        overwrittenVotesCount: bigint;
        nBlobs: bigint;
      }
    | { name: 'ProcessResultsSet'; processId: string; sender: string; result: bigint[] }
    | {
        name: 'ResultsDecryptionRequested';
        processId: string;
        epochId: string;
        aid: string;
        firstIndex: number;
        count: number;
      }
  );

/** The name of a registry event. */
export type RegistryEventName = RegistryEvent['name'];

/**
 * Generic callback type for contract events.
 * @template T - Tuple type representing the event arguments
 */
export type EntityCallback<T extends unknown[]> = (...args: T) => void;

/**
 * Callback for when a process is created.
 * @param processID - The process ID
 * @param creator - Address of the account that created the process
 */
export type ProcessCreatedCallback = EntityCallback<[string, string]>;

/**
 * Callback for when a process status changes.
 * @param processID - The process ID
 * @param oldStatus - The previous status
 * @param newStatus - The new status
 */
export type ProcessStatusChangedCallback = EntityCallback<[string, bigint, bigint]>;

/**
 * Callback for when a process census is updated.
 * @param processID - The process ID
 * @param root - The new census root
 * @param uri - The new census URI
 */
export type ProcessCensusUpdatedCallback = EntityCallback<[string, string, string]>;

/**
 * Callback for when a process metadata document is replaced.
 * @param processID - The process ID
 * @param uri - The new metadata URI
 * @param hash - SHA-256 of the document at `uri`
 */
export type ProcessMetadataUpdatedCallback = EntityCallback<[string, string, string]>;

/**
 * Callback for when a process duration changes.
 * @param processID - The process ID
 * @param duration - The new duration
 */
export type ProcessDurationChangedCallback = EntityCallback<[string, bigint]>;

/**
 * Callback for when a process grace window changes.
 * @param processID - The process ID
 * @param grace - The new grace window, in seconds
 */
export type ProcessGraceChangedCallback = EntityCallback<[string, bigint]>;

/**
 * Callback for when a process state transitions (valid state transition published).
 * @param processID - The process ID
 * @param sender - Address of the account that updated the state root
 * @param oldStateRoot - The state root before the state transition (`bytes32`)
 * @param newStateRoot - The new state root after the state transition (`bytes32`)
 * @param newVotersCount - The number of distinct ballot slots written after the state transition
 * @param newOverwrittenVotesCount - The number of votes that has been overwritten updated after the state transition
 * @param nBlobs - The blobs the transition carried
 */
export type ProcessStateTransitionedCallback = EntityCallback<
  [string, string, string, string, bigint, bigint, bigint]
>;

/**
 * Callback for when process results are set.
 * @param processID - The process ID
 * @param sender - Address of the account that set the results
 * @param result - The results array
 */
export type ProcessResultsSetCallback = EntityCallback<[string, string, bigint[]]>;

/**
 * Callback for when the DKG committee is asked to decrypt a process's tally.
 * @param processID - The process ID
 * @param epochId - The DKG epoch (`bytes12`)
 * @param aid - The DKG application id (`bytes32`)
 * @param firstIndex - DKG index of the first submitted ciphertext
 * @param count - Ciphertexts submitted
 */
export type ResultsDecryptionRequestedCallback = EntityCallback<
  [string, string, string, bigint, bigint]
>;

/**
 * Callback for when process maxVoters is changed.
 * @param processID - The process ID
 * @param maxVoters - The new maxVoters value
 */
export type ProcessMaxVotersChangedCallback = EntityCallback<[string, bigint]>;
