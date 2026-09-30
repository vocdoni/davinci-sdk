import {
  Contract,
  Interface,
  ZeroAddress,
  getAddress,
  keccak256,
  toBeHex,
  zeroPadBytes,
  zeroPadValue,
  type ContractRunner,
  type Provider,
  type Result,
  type Signer,
  type TransactionReceipt,
} from 'ethers';
import {
  SmartContractService,
  TxStatus,
  decodeRevert,
  type ContractErrorFactory,
  type TxStatusEvent,
} from './SmartContractService';
import {
  DAVINCI_DKG_ADAPTER_ABI,
  DKG_APP_MANAGER_ABI,
  PROCESS_REGISTRY_ABI,
  ZISK_VERIFIER_ABI,
  type DavinciErrorDescription,
} from './abis';
import {
  CensusNotUpdatable,
  ContractServiceError,
  DeploymentPinError,
  DkgDisabledError,
  ProcessCensusError,
  ProcessCreateError,
  ProcessDurationError,
  ProcessGraceError,
  ProcessKeyRevealError,
  ProcessMaxVotersError,
  ProcessMetadataError,
  ProcessNotFoundError,
  ProcessResultError,
  ProcessStatusError,
  WrongProcessIdError,
} from './errors';
import {
  KeyMode,
  ProcessStatus,
  type DeploymentInfo,
  type DkgParams,
  type GraceParams,
  type NewProcessParams,
  type OnchainDkg,
  type OnchainProcess,
  type ProcessCensusUpdatedCallback,
  type ProcessCreatedCallback,
  type ProcessDurationChangedCallback,
  type ProcessGraceChangedCallback,
  type ProcessMaxVotersChangedCallback,
  type ProcessMetadataUpdatedCallback,
  type ProcessResultsSetCallback,
  type ProcessStateTransitionedCallback,
  type ProcessStatusChangedCallback,
  type RegistryCensus,
  type RegistryEvent,
  type ResultsDecryptionRequestedCallback,
} from './types';
import { dkgAutomaticParams, dkgLockedParams, sequencerKeyParams } from './params';
import { type BjjPoint, toBjjPoint } from '../crypto/babyjubjub';
import { proveOrganizerKey, randomOrganizerSecret } from '../crypto/dkg';
import { type BallotModeValues, packBallotMode } from '../crypto/ballot';
import type { CensusOrigin } from '../census/types';
import { RELEASE_PINS } from '../protocol/release';
import { NETWORKS } from '../networks';

/** Seconds a shortened end leaves past the notice for the transaction's own inclusion. */
export const SHORTEN_SLACK_SECONDS = 45;

/**
 * Blocks per `eth_getLogs` of {@link ProcessRegistryService.eventWindows}:
 * under the caps of public RPCs (Gnosis providers commonly allow 10,000).
 */
export const LOG_BLOCK_RANGE = 5_000;

const registryInterface = new Interface(PROCESS_REGISTRY_ABI);

type ErrorClass = new (
  message: string,
  operation: string,
  revert?: DavinciErrorDescription,
  cause?: unknown
) => ContractServiceError;

// The factory of `method`'s errors of class `ErrorType`.
function errorsOf(ErrorType: ErrorClass, method: string): ContractErrorFactory {
  return (message, revert, cause) => new ErrorType(message, method, revert, cause);
}

// A process creation failure as a ContractServiceError.
function createError(err: unknown): ContractServiceError {
  if (err instanceof ContractServiceError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ProcessCreateError(`newProcess: ${message}`, 'newProcess', undefined, err);
}

// Typed readers of an ethers `Result`; a value of the wrong type is a decoding bug.
function field(r: Result, name: string): unknown {
  return r.getValue(name) as unknown;
}

function big(v: unknown, what: string): bigint {
  if (typeof v !== 'bigint') throw new TypeError(`${what}: want an integer`);
  return v;
}

function small(v: unknown, what: string): number {
  return Number(big(v, what));
}

function text(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new TypeError(`${what}: want a string`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new TypeError(`${what}: want a boolean`);
  return v;
}

function tuple(v: unknown, what: string): Result {
  if (!Array.isArray(v)) throw new TypeError(`${what}: want a tuple`);
  return v as Result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A uint256 argument given as a JS number or bigint; a negative one would only
// fail at ABI encoding, with no hint of which argument.
function unsigned(v: bigint | number, what: string): bigint {
  const n = BigInt(v);
  if (n < 0n) throw new RangeError(`${what} ${n} is negative`);
  return n;
}

// Whole seconds, for the arithmetic of a shortened end.
function wholeSeconds(v: number, what: string): bigint {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(`${what} ${String(v)} is not a whole number of seconds`);
  }
  return BigInt(v);
}

// A unix time for messages.
function when(seconds: bigint): string {
  return seconds < 8_640_000_000_000n
    ? new Date(Number(seconds) * 1000).toISOString()
    : `${seconds} (unix)`;
}

function bytesHex(v: unknown, what: string): string {
  return text(v, what).toLowerCase();
}

// A census root as `bytes32`: a bigint, or big-endian hex of at most 32 bytes.
function censusRoot(root: string | bigint): string {
  return typeof root === 'bigint' ? toBeHex(root, 32) : zeroPadValue(root, 32);
}

function census(c: RegistryCensus) {
  return {
    censusOrigin: c.origin,
    censusRoot: censusRoot(c.root),
    contractAddress: c.contractAddress ?? ZeroAddress,
    censusURI: c.uri,
    // The zkVM registry refuses `true` (InvalidCensusConfig).
    onchainAllowAnyValidRoot: false,
  };
}

function ballotMode(m: BallotModeValues) {
  return {
    uniqueValues: m.uniqueValues,
    numFields: m.numFields,
    groupSize: m.groupSize,
    costExponent: m.costExponent,
    maxValue: m.maxValue,
    minValue: m.minValue,
    maxValueSum: m.maxValueSum,
    minValueSum: m.minValueSum,
  };
}

function normalizePid(processId: string): string {
  const h = processId.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{62}$/.test(h)) throw new TypeError(`${processId} is not a process id`);
  return `0x${h.toLowerCase()}`;
}

function decodeProcess(processId: string, r: Result): OnchainProcess {
  const organizationId = getAddress(text(field(r, 'organizationId'), 'organizationId'));
  if (organizationId === ZeroAddress) {
    throw new ProcessNotFoundError(`process ${processId} not found`, 'getProcess');
  }
  const status = small(field(r, 'status'), 'status');
  if (!(status in ProcessStatus)) throw new TypeError(`unknown process status ${status}`);
  const keyMode = small(field(r, 'keyMode'), 'keyMode') as KeyMode;
  if (!(keyMode in KeyMode)) throw new TypeError(`unknown key mode ${keyMode}`);
  const key = tuple(field(r, 'encryptionKey'), 'encryptionKey');
  const bm = tuple(field(r, 'ballotMode'), 'ballotMode');
  const c = tuple(field(r, 'census'), 'census');
  const result = tuple(field(r, 'result'), 'result');
  return {
    processId,
    status: status as ProcessStatus,
    organizationId,
    encryptionKey: toBjjPoint(big(field(key, 'x'), 'key x'), big(field(key, 'y'), 'key y')),
    latestStateRoot: bytesHex(field(r, 'latestStateRoot'), 'latestStateRoot'),
    result: result.map((v, i) => big(v, `result[${i}]`)),
    startTime: big(field(r, 'startTime'), 'startTime'),
    duration: big(field(r, 'duration'), 'duration'),
    maxVoters: big(field(r, 'maxVoters'), 'maxVoters'),
    votersCount: big(field(r, 'votersCount'), 'votersCount'),
    overwrittenVotesCount: big(field(r, 'overwrittenVotesCount'), 'overwrittenVotesCount'),
    creationBlock: big(field(r, 'creationBlock'), 'creationBlock'),
    batchNumber: big(field(r, 'batchNumber'), 'batchNumber'),
    metadataUri: text(field(r, 'metadataURI'), 'metadataURI'),
    metadataHash: bytesHex(field(r, 'metadataHash'), 'metadataHash'),
    ballotMode: {
      numFields: small(field(bm, 'numFields'), 'numFields'),
      groupSize: small(field(bm, 'groupSize'), 'groupSize'),
      uniqueValues: bool(field(bm, 'uniqueValues'), 'uniqueValues'),
      costExponent: small(field(bm, 'costExponent'), 'costExponent'),
      maxValue: big(field(bm, 'maxValue'), 'maxValue'),
      minValue: big(field(bm, 'minValue'), 'minValue'),
      maxValueSum: big(field(bm, 'maxValueSum'), 'maxValueSum'),
      minValueSum: big(field(bm, 'minValueSum'), 'minValueSum'),
    },
    census: {
      origin: small(field(c, 'censusOrigin'), 'censusOrigin') as CensusOrigin,
      root: bytesHex(field(c, 'censusRoot'), 'censusRoot'),
      contractAddress: getAddress(text(field(c, 'contractAddress'), 'contractAddress')),
      uri: text(field(c, 'censusURI'), 'censusURI'),
    },
    keyMode,
    ...(keyMode !== KeyMode.Sequencer && {
      dkg: {
        locked: keyMode === KeyMode.DkgLocked,
        epochId: bytesHex(field(r, 'dkgEpochId'), 'dkgEpochId'),
        aid: bytesHex(field(r, 'dkgAid'), 'dkgAid'),
        resultsRequested: bool(field(r, 'dkgResultsRequested'), 'dkgResultsRequested'),
        firstIndex: small(field(r, 'dkgFirstIndex'), 'dkgFirstIndex'),
        count: small(field(r, 'dkgCount'), 'dkgCount'),
        zeroSkipped: small(field(r, 'dkgZeroSkipped'), 'dkgZeroSkipped'),
      },
    }),
    grace: small(field(r, 'grace'), 'grace'),
    lastVoteAt: big(field(r, 'lastVoteAt'), 'lastVoteAt'),
  };
}

/** A log as a provider or a receipt returns it. */
export interface RegistryLog {
  topics: readonly string[];
  data: string;
  address?: string;
  blockNumber?: number;
  transactionHash?: string;
  /** ethers `Log.index`. */
  index?: number;
  /** JSON-RPC `logIndex`. */
  logIndex?: number;
}

/**
 * Decodes a registry log into a typed event; null for a log that is not a
 * registry event. It trusts the log's origin: filter by the registry address
 * first, or use {@link parseRegistryLogs}.
 *
 * @example
 * ```typescript
 * const created = parseRegistryLogs(receipt.logs, registry.address).find(
 *   e => e.name === 'ProcessCreated'
 * );
 * ```
 */
export function parseRegistryLog(log: RegistryLog): RegistryEvent | null {
  let parsed;
  try {
    parsed = registryInterface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const a = parsed.args;
  const pid = bytesHex(field(a, 'processId'), 'processId');
  const base = {
    blockNumber: log.blockNumber ?? 0,
    transactionHash: log.transactionHash ?? '',
    logIndex: log.index ?? log.logIndex ?? 0,
    processId: pid,
  };
  switch (parsed.name) {
    case 'ProcessCreated':
      return {
        ...base,
        name: 'ProcessCreated',
        creator: getAddress(text(field(a, 'creator'), 'creator')),
      };
    case 'ProcessStatusChanged':
      return {
        ...base,
        name: 'ProcessStatusChanged',
        oldStatus: small(field(a, 'oldStatus'), 'oldStatus') as ProcessStatus,
        newStatus: small(field(a, 'newStatus'), 'newStatus') as ProcessStatus,
      };
    case 'CensusUpdated':
      return {
        ...base,
        name: 'CensusUpdated',
        censusRoot: bytesHex(field(a, 'censusRoot'), 'censusRoot'),
        censusUri: text(field(a, 'censusURI'), 'censusURI'),
      };
    case 'ProcessMetadataUpdated':
      return {
        ...base,
        name: 'ProcessMetadataUpdated',
        metadataUri: text(field(a, 'metadataURI'), 'metadataURI'),
        metadataHash: bytesHex(field(a, 'metadataHash'), 'metadataHash'),
      };
    case 'ProcessDurationChanged':
      return {
        ...base,
        name: 'ProcessDurationChanged',
        duration: big(field(a, 'duration'), 'duration'),
      };
    case 'ProcessMaxVotersChanged':
      return {
        ...base,
        name: 'ProcessMaxVotersChanged',
        maxVoters: big(field(a, 'maxVoters'), 'maxVoters'),
      };
    case 'ProcessGraceChanged':
      return { ...base, name: 'ProcessGraceChanged', grace: small(field(a, 'grace'), 'grace') };
    case 'ProcessStateTransitioned':
      return {
        ...base,
        name: 'ProcessStateTransitioned',
        sender: getAddress(text(field(a, 'sender'), 'sender')),
        oldStateRoot: bytesHex(field(a, 'oldStateRoot'), 'oldStateRoot'),
        newStateRoot: bytesHex(field(a, 'newStateRoot'), 'newStateRoot'),
        votersCount: big(field(a, 'newVotersCount'), 'newVotersCount'),
        overwrittenVotesCount: big(
          field(a, 'newOverwrittenVotesCount'),
          'newOverwrittenVotesCount'
        ),
        nBlobs: big(field(a, 'nBlobs'), 'nBlobs'),
      };
    case 'ProcessResultsSet':
      return {
        ...base,
        name: 'ProcessResultsSet',
        sender: getAddress(text(field(a, 'sender'), 'sender')),
        result: tuple(field(a, 'result'), 'result').map((v, i) => big(v, `result[${i}]`)),
      };
    case 'ResultsDecryptionRequested':
      return {
        ...base,
        name: 'ResultsDecryptionRequested',
        epochId: bytesHex(field(a, 'epochId'), 'epochId'),
        aid: bytesHex(field(a, 'aid'), 'aid'),
        firstIndex: small(field(a, 'firstIndex'), 'firstIndex'),
        count: small(field(a, 'count'), 'count'),
      };
    default:
      return null;
  }
}

/** The registry events among `logs` emitted by `registry`, in order. */
export function parseRegistryLogs(logs: readonly RegistryLog[], registry: string): RegistryEvent[] {
  const address = registry.toLowerCase();
  return logs
    .filter(l => l.address?.toLowerCase() === address)
    .map(parseRegistryLog)
    .filter((e): e is RegistryEvent => e !== null);
}

/** Options of {@link ProcessRegistryService.newProcess}. */
export interface NewProcessOptions {
  /**
   * The id a sequencer key was issued for (`getNextProcessId` before the
   * key request). The stream fails before sending when the registry no longer
   * assigns it next. If another process from the account still lands first,
   * the stream fails with {@link WrongProcessIdError}: the process exists,
   * but no node holds its key, so cancel it.
   */
  expectedProcessId?: string;
}

/** What {@link ProcessRegistryService.newProcess} created. */
export interface CreatedProcess {
  /** From the receipt's `ProcessCreated` event. */
  processId: string;
  transactionHash: string;
  /**
   * DKG_LOCKED processes from {@link ProcessRegistryService.createProcess}:
   * the organizer secret `revealProcessKey` needs. Nothing stores it; lose
   * it and the results never unlock.
   */
  organizerSecret?: bigint;
}

/** Arguments of {@link ProcessRegistryService.createProcess}. */
export interface CreateProcessParams extends Omit<NewProcessParams, 'dkg'> {
  /** The id the registry assigns next (`getNextProcessId`); a sequencer key is bound to it. */
  processId: string;
  keyMode: KeyMode;
  /** The key a sequencer issued for `processId`; SEQUENCER mode only. */
  encryptionKey?: BjjPoint;
}

/**
 * On-chain client for the Vocdoni DaVinci process registry contract.
 *
 * Wraps the `ProcessRegistry` contract (the ABI vendored in
 * `src/contracts/abi`) with typed reads, typed events and every write an
 * organizer needs: create a process in any key mode, change its status,
 * census, metadata, duration (with the shorten notice), max voters and grace
 * window, reveal a DKG-locked key and finalize DKG results.
 *
 * Every write is simulated before it is signed, so a revert comes back as
 * the operation's error with the decoded custom error (`revertName`), and
 * nothing is sent until its stream is iterated. `verifyDeployment` checks the
 * registry pins what this release proves.
 *
 * Bound to a single contract address per instance and to whichever
 * `ContractRunner` (provider or signer) is passed at construction.
 * Write operations require a signer; read operations work with either.
 *
 * For most applications, prefer the high-level {@link DavinciSDK}
 * facade, which composes this service with the sequencer and census
 * layers. Use this class directly when you need on-chain operations
 * that are not surfaced through `DavinciSDK`.
 */
export class ProcessRegistryService extends SmartContractService {
  private readonly contract: Contract;
  /** The registry address, checksummed. */
  readonly address: string;

  /**
   * @param contractAddress - The `ProcessRegistry` address
   * @param runner - A provider for reads, a signer (with a provider) for writes
   * @param options - `receiptTimeoutMs`: longest wait for a receipt (default 180 s)
   */
  constructor(
    contractAddress: string,
    runner: ContractRunner,
    options: { receiptTimeoutMs?: number } = {}
  ) {
    super();
    this.address = getAddress(contractAddress);
    this.contract = new Contract(this.address, PROCESS_REGISTRY_ABI, runner);
    if (options.receiptTimeoutMs !== undefined) this.receiptTimeoutMs = options.receiptTimeoutMs;
  }

  // A view call's first return value.
  private async read(method: string, ...args: unknown[]): Promise<unknown> {
    return (await this.contract.getFunction(method).staticCall(...args)) as unknown;
  }

  private provider(): Provider {
    const runner = this.contract.runner;
    const provider = runner?.provider ?? (runner as Provider | null);
    if (!provider || typeof provider.getNetwork !== 'function') {
      throw new Error('a provider is required');
    }
    return provider;
  }

  // A write stream; arguments that do not build fail the stream, not the call.
  private write<T>(
    method: string,
    args: () => readonly unknown[],
    error: ContractErrorFactory,
    onReceipt: (receipt: TransactionReceipt) => T | Promise<T>
  ): AsyncGenerator<TxStatusEvent<T>, void, unknown> {
    return this.sendContractTx({ contract: this.contract, method, args, error, onReceipt });
  }

  private writeDone(method: string, args: () => readonly unknown[], ErrorType: ErrorClass) {
    return this.write(method, args, errorsOf(ErrorType, method), () => ({ success: true }));
  }

  // ─── READS ─────────────────────────────────────────────────────────

  /**
   * The process as the registry stores it.
   *
   * @throws ProcessNotFoundError when the registry holds no such process
   */
  async getProcess(processId: string): Promise<OnchainProcess> {
    const pid = normalizePid(processId);
    return decodeProcess(pid, tuple(await this.read('getProcess', pid), 'process'));
  }

  /** The latest block's time, unix seconds: the clock the registry's time rules run on. */
  async getChainTime(): Promise<bigint> {
    const head = await this.provider().getBlock('latest');
    if (!head) throw new Error('no latest block');
    return BigInt(head.timestamp);
  }

  /** Processes created on this registry. */
  async getProcessCount(): Promise<number> {
    return small(await this.read('processCount'), 'processCount');
  }

  /** The chain id the registry was deployed for, as a decimal string. */
  async getChainID(): Promise<string> {
    return big(await this.read('chainID'), 'chainID').toString();
  }

  /** The id `newProcess` from `organizationId` gets next: ask the sequencer for this id's key. */
  async getNextProcessId(organizationId: string): Promise<string> {
    return bytesHex(await this.read('getNextProcessId', organizationId), 'processId');
  }

  /** `startTime + duration`, unix seconds. */
  async getProcessEndTime(processId: string): Promise<bigint> {
    return big(await this.read('getProcessEndTime', normalizePid(processId)), 'endTime');
  }

  /**
   * Block time the grace window closes at:
   * `min(end + graceMaxTotal, max(end, lastVoteAt) + grace)`. It moves forward
   * with every landing; results unlock after it.
   */
  async getProcessGraceEnd(processId: string): Promise<bigint> {
    return big(await this.read('getProcessGraceEnd', normalizePid(processId)), 'graceEnd');
  }

  /** The registry's grace window immutables. */
  async getGraceParams(): Promise<GraceParams> {
    const [defaultGrace, graceFloor, graceCeil, graceMaxTotal, noticeMin] = await Promise.all(
      ['defaultGrace', 'graceFloor', 'graceCeil', 'graceMaxTotal', 'noticeMin'].map(async m =>
        small(await this.read(m), m)
      )
    );
    return { defaultGrace, graceFloor, graceCeil, graceMaxTotal, noticeMin };
  }

  /** Processes `address` created so far (its next process id's nonce). */
  async getProcessNonce(address: string): Promise<bigint> {
    return big(await this.read('processNonce', address), 'processNonce');
  }

  /** Highest valid `ProcessStatus`. */
  async getMaxStatus(): Promise<bigint> {
    return big(await this.read('MAX_STATUS'), 'MAX_STATUS');
  }

  /** Bytes 20..23 of every process id this registry assigns, `0x` + 8 hex digits. */
  async getPidPrefix(): Promise<string> {
    return toBeHex(big(await this.read('pidPrefix'), 'pidPrefix'), 4);
  }

  /** The `ZiskVerifier` the registry calls. */
  async getZiskVerifier(): Promise<string> {
    return getAddress(text(await this.read('ziskVerifier'), 'ziskVerifier'));
  }

  /** Vote-batch guest program vk (`batchProgramVK()`). */
  async getBatchProgramVK(): Promise<string> {
    return bytesHex(await this.read('batchProgramVK'), 'batchProgramVK');
  }

  /** Results guest program vk (`resultsProgramVK()`). */
  async getResultsProgramVK(): Promise<string> {
    return bytesHex(await this.read('resultsProgramVK'), 'resultsProgramVK');
  }

  /** ZisK vadcop-final setup root (`rootCVadcopFinal()`). */
  async getRootCVadcopFinal(): Promise<string> {
    return bytesHex(await this.read('rootCVadcopFinal'), 'rootCVadcopFinal');
  }

  /** sha256 of the ballot proof VK wire bytes (`ballotVKHash()`): the key ballots must be proved under. */
  async getBallotVKHash(): Promise<string> {
    return bytesHex(await this.read('ballotVKHash'), 'ballotVKHash');
  }

  /** The registry's DKG adapter; null when the DKG key modes are disabled. */
  async getDkgAdapter(): Promise<string | null> {
    const a = getAddress(text(await this.read('dkgAdapter'), 'dkgAdapter'));
    return a === ZeroAddress ? null : a;
  }

  // The adapter, or DkgDisabledError.
  private async adapter(operation: string): Promise<Contract> {
    const a = await this.getDkgAdapter();
    if (!a) {
      throw new DkgDisabledError(
        'the registry has no DKG adapter: DKG key modes are disabled',
        operation
      );
    }
    return new Contract(a, DAVINCI_DKG_ADAPTER_ABI, this.contract.runner);
  }

  /**
   * The DKG application id of a (future) process, `bytes32` hex: what a
   * locked process's proof of possession binds.
   *
   * @throws DkgDisabledError on a registry without DKG
   */
  async aidFor(processId: string): Promise<string> {
    try {
      return bytesHex(await this.read('aidFor', normalizePid(processId)), 'aid');
    } catch (err) {
      const revert = decodeRevert(err);
      if (revert?.name === 'DKGDisabled') {
        throw new DkgDisabledError('DKG key modes are disabled', 'aidFor', revert, err);
      }
      throw err;
    }
  }

  /**
   * The DKG epoch new processes register in (`adapter.registrationEpoch()`),
   * `bytes12` hex: what a locked process's `DKGParams.epochId` must be.
   *
   * @throws DkgDisabledError on a registry without DKG
   */
  async getRegistrationEpoch(): Promise<string> {
    const adapter = await this.adapter('registrationEpoch');
    const epoch = (await adapter.getFunction('registrationEpoch').staticCall()) as unknown;
    return bytesHex(epoch, 'registrationEpoch');
  }

  /**
   * The committee's decryption of a DKG process's tally
   * (`adapter.plaintexts`): `ready` once every ciphertext the decryption
   * request submitted is combined, and then the plaintexts in submission
   * order. A request with no active field submitted none, so it is ready with
   * none. `finalizeResultsFromDKG` stores them.
   *
   * @param dkg - The process's `dkg` (`getProcess`), after the request
   * @throws DkgDisabledError on a registry without DKG
   */
  async getDkgPlaintexts(dkg: OnchainDkg): Promise<{ ready: boolean; values: bigint[] }> {
    if (dkg.count === 0) return { ready: true, values: [] };
    const adapter = await this.adapter('plaintexts');
    const r = tuple(
      await adapter
        .getFunction('plaintexts')
        .staticCallResult(dkg.epochId, dkg.aid, dkg.firstIndex, dkg.count),
      'plaintexts'
    );
    return {
      ready: bool(field(r, 'ready'), 'ready'),
      values: tuple(field(r, 'values'), 'values').map((v, i) => big(v, `values[${i}]`)),
    };
  }

  /**
   * Whether the organizer of a DKG_LOCKED process revealed its secret
   * (`revealProcessKey`), read from the DKG application manager: the
   * committee combines nothing before. Always false for DKG_AUTOMATIC.
   *
   * @param dkg - The process's `dkg` (`getProcess`)
   * @throws DkgDisabledError on a registry without DKG
   */
  async isProcessKeyRevealed(dkg: OnchainDkg): Promise<boolean> {
    const adapter = await this.adapter('appManager');
    const manager = getAddress(
      text(await adapter.getFunction('appManager').staticCall(), 'appManager')
    );
    const apps = new Contract(manager, DKG_APP_MANAGER_ABI, this.contract.runner);
    const app = tuple(
      await apps.getFunction('getApplication').staticCall(dkg.epochId, dkg.aid),
      'application'
    );
    return big(field(app, 'organizerSecret'), 'organizerSecret') !== 0n;
  }

  /**
   * Checks the registry settles what this SDK release proves and verifies,
   * as the Rust organizer does before trusting a deployment: the batch and
   * results program vks, `rootCVadcopFinal` and the ballot VK hash equal the
   * release pins, `chainID()` equals the provider's chain, the verifier's
   * runtime code hashes to the pinned code hash and its root is the pinned
   * one, and a DKG adapter, if any, names this registry.
   *
   * @param pins - Overrides of {@link RELEASE_PINS} (a local deployment)
   * @throws DeploymentPinError at the first mismatch
   */
  async verifyDeployment(
    pins: Partial<Record<keyof typeof RELEASE_PINS, string>> = {}
  ): Promise<DeploymentInfo> {
    const want = { ...RELEASE_PINS, ...pins };
    const check = (pin: string, expected: string, got: string) => {
      if (expected.toLowerCase() !== got.toLowerCase()) {
        throw new DeploymentPinError(pin, expected, got);
      }
    };
    check('batchProgramVK', want.batchProgramVK, await this.getBatchProgramVK());
    check('resultsProgramVK', want.resultsProgramVK, await this.getResultsProgramVK());
    check('rootCVadcopFinal', want.rootCVadcopFinal, await this.getRootCVadcopFinal());
    check('ballotVKHash', want.ballotVKHash, await this.getBallotVKHash());

    const provider = this.provider();
    const { chainId } = await provider.getNetwork();
    check('chainID', chainId.toString(), await this.getChainID());

    const verifier = await this.getZiskVerifier();
    check(
      'verifier code hash',
      want.ziskVerifierCodeHash,
      keccak256(await provider.getCode(verifier))
    );
    const zisk = new Contract(verifier, ZISK_VERIFIER_ABI, provider);
    const root = (await zisk.getFunction('getRootCVadcopFinal').staticCall()) as unknown;
    check('verifier rootCVadcopFinal', want.rootCVadcopFinal, bytesHex(root, 'root'));

    const dkgAdapter = await this.getDkgAdapter();
    if (dkgAdapter) {
      const adapter = new Contract(dkgAdapter, DAVINCI_DKG_ADAPTER_ABI, provider);
      const back = (await adapter.getFunction('registry').staticCall()) as unknown;
      check('dkgAdapter.registry', this.address, getAddress(text(back, 'registry')));
    }
    return { chainId, verifier, dkgAdapter };
  }

  // The deployment block of a known network's registry, when `fromBlock` is not given.
  private async startBlock(fromBlock: number | undefined, what: string): Promise<number> {
    if (fromBlock !== undefined) return fromBlock;
    const { chainId } = await this.provider().getNetwork();
    const known = NETWORKS.find(
      n =>
        BigInt(n.chainId) === chainId &&
        n.processRegistry.toLowerCase() === this.address.toLowerCase()
    )?.startBlock;
    if (known === undefined) {
      throw new Error(`${what}: fromBlock is required for a registry outside the known networks`);
    }
    return known;
  }

  /**
   * The registry events of a block range, optionally of one process, decoded
   * and in order. `fromBlock` defaults to the deployment block of a known
   * network's registry and is required for any other registry. The range is
   * one `eth_getLogs` call: public RPCs cap it, so narrow it to the process's
   * `creationBlock` onwards, or use {@link eventWindows}.
   */
  async queryEvents(
    options: { processId?: string; fromBlock?: number; toBlock?: number | 'latest' } = {}
  ): Promise<RegistryEvent[]> {
    const fromBlock = await this.startBlock(options.fromBlock, 'queryEvents');
    // An indexed bytes31 is its 31 bytes padded on the right.
    const topic = options.processId ? zeroPadBytes(normalizePid(options.processId), 32) : null;
    const logs = await this.provider().getLogs({
      address: this.address,
      fromBlock,
      toBlock: options.toBlock ?? 'latest',
      topics: topic ? [null, topic] : undefined,
    });
    return parseRegistryLogs(logs, this.address);
  }

  /**
   * {@link queryEvents} in windows of `blockRange` blocks (default
   * {@link LOG_BLOCK_RANGE}), newest window first, from `toBlock` (default the
   * head) down to `fromBlock`: public RPCs cap the range of one `eth_getLogs`.
   * Each window's events are in order; stop iterating once found.
   *
   * @example
   * ```typescript
   * for await (const events of registry.eventWindows({ processId, fromBlock })) {
   *   const found = events.find(e => e.name === 'ProcessResultsSet');
   *   if (found) break;
   * }
   * ```
   */
  async *eventWindows(
    options: { processId?: string; fromBlock?: number; toBlock?: number; blockRange?: number } = {}
  ): AsyncGenerator<RegistryEvent[], void, unknown> {
    const range = options.blockRange ?? LOG_BLOCK_RANGE;
    if (!Number.isSafeInteger(range) || range < 1) {
      throw new RangeError(`blockRange ${String(range)} is not a positive integer`);
    }
    const fromBlock = await this.startBlock(options.fromBlock, 'eventWindows');
    let to = options.toBlock ?? (await this.provider().getBlockNumber());
    while (to >= fromBlock) {
      const from = Math.max(fromBlock, to - range + 1);
      yield await this.queryEvents({ processId: options.processId, fromBlock: from, toBlock: to });
      to = from - 1;
    }
  }

  // ─── WRITES ────────────────────────────────────────────────────────

  /**
   * Creates a process (`newProcess`) and reads its id from the receipt's
   * `ProcessCreated` event (this registry, this sender).
   *
   * SEQUENCER mode takes the key a node issued for `getNextProcessId(sender)`;
   * pass that id as `expectedProcessId`, and the stream fails before sending
   * if the registry no longer assigns it. The DKG modes take no key: their
   * `dkg` comes from `dkgAutomaticParams()` or `dkgLockedParams()`. One send,
   * no retry: {@link createProcess} builds the key mode arguments and retries
   * a DKG creation once, like the Rust organizer.
   *
   * @example
   * ```typescript
   * const created = await SmartContractService.executeTx(
   *   registry.newProcess(params, { expectedProcessId: nextId })
   * );
   * ```
   */
  async *newProcess(
    params: NewProcessParams,
    options: NewProcessOptions = {}
  ): AsyncGenerator<TxStatusEvent<CreatedProcess>, void, unknown> {
    const method = 'newProcess';
    if (options.expectedProcessId !== undefined) {
      try {
        await this.checkNextProcessId(options.expectedProcessId);
      } catch (err) {
        yield { status: TxStatus.Failed, error: createError(err) };
        return;
      }
    }
    let expected: string | undefined;
    const created = (receipt: TransactionReceipt): CreatedProcess => {
      const sender = getAddress(receipt.from);
      const event = parseRegistryLogs(receipt.logs, this.address).find(
        e => e.name === 'ProcessCreated' && e.creator === sender
      );
      if (!event) {
        throw new ProcessCreateError('no ProcessCreated event in the receipt', method);
      }
      if (expected && event.processId !== expected) {
        throw new WrongProcessIdError(event.processId, expected);
      }
      return { processId: event.processId, transactionHash: receipt.hash };
    };
    const args = () => {
      expected = options.expectedProcessId && normalizePid(options.expectedProcessId);
      packBallotMode(params.ballotMode);
      const key = params.encryptionKey ?? { x: 0n, y: 0n };
      return [
        params.status ?? ProcessStatus.READY,
        unsigned(params.startTime, 'startTime'),
        unsigned(params.duration, 'duration'),
        unsigned(params.maxVoters, 'maxVoters'),
        ballotMode(params.ballotMode),
        census(params.census),
        params.metadataUri,
        params.metadataHash,
        { x: key.x, y: key.y },
        params.dkg ?? sequencerKeyParams(),
      ];
    };
    yield* this.write(method, args, errorsOf(ProcessCreateError, method), created);
  }

  // Fails unless the registry assigns `expected` to this signer's next process.
  private async checkNextProcessId(expected: string): Promise<void> {
    const want = normalizePid(expected);
    const signer = this.contract.runner as Signer | null;
    if (!signer || typeof signer.getAddress !== 'function') {
      throw new ProcessCreateError(
        'newProcess: a signer connected to a provider is required',
        'newProcess'
      );
    }
    const next = await this.getNextProcessId(await signer.getAddress());
    if (next !== want) {
      throw new ProcessCreateError(
        `newProcess: the registry assigns ${next} next, the key was issued for ${want}`,
        'newProcess'
      );
    }
  }

  /**
   * Creates a process in any key mode the way the organizer of the Rust
   * client does: it checks the registry assigns `processId` next, builds the
   * DKG arguments itself and retries once in the DKG modes, when the epoch
   * pool is exhausted (simulated or mined) or, for DKG_LOCKED, when the
   * registration epoch moved meanwhile. A retry after a mined revert yields a
   * second `Pending`.
   *
   * - SEQUENCER: `encryptionKey` is the key a node issued for `processId`; a
   *   process created under another id fails with {@link WrongProcessIdError}.
   * - DKG_AUTOMATIC: no key; the committee decrypts the tally.
   * - DKG_LOCKED: no key; an organizer secret is drawn here, proved for the
   *   registration epoch and `aidFor(processId)`, and returned in the
   *   `Completed` response. Results stay locked until `revealProcessKey`.
   *
   * Failures come as `Failed` or `Reverted` events: {@link DkgDisabledError}
   * for a DKG mode on a registry without DKG, else a {@link ProcessCreateError}
   * (or {@link WrongProcessIdError}) with the decoded revert.
   */
  async *createProcess(
    params: CreateProcessParams
  ): AsyncGenerator<TxStatusEvent<CreatedProcess>, void, unknown> {
    const method = 'newProcess';
    const { processId, keyMode, ...rest } = params;
    const dkg = keyMode !== KeyMode.Sequencer;
    const locked = keyMode === KeyMode.DkgLocked;
    let pid: string;
    try {
      pid = normalizePid(processId);
      if (dkg && params.encryptionKey) {
        throw new ProcessCreateError(
          'newProcess: the DKG key modes take no encryption key',
          method
        );
      }
      if (!dkg && !params.encryptionKey) {
        throw new ProcessCreateError('newProcess: SEQUENCER mode needs the sequencer key', method);
      }
      if (dkg) {
        // SEQUENCER mode checks the id in newProcess (expectedProcessId).
        await this.checkNextProcessId(pid);
        await this.adapter(method);
      }
    } catch (err) {
      yield { status: TxStatus.Failed, error: createError(err) };
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let dkgParams: DkgParams;
      let secret: bigint | undefined;
      try {
        if (locked) {
          const epochId = await this.getRegistrationEpoch();
          secret = randomOrganizerSecret();
          const aid = await this.aidFor(pid);
          dkgParams = dkgLockedParams(epochId, proveOrganizerKey({ epochId, aid, secret }));
        } else {
          dkgParams = dkg ? dkgAutomaticParams() : sequencerKeyParams();
        }
      } catch (err) {
        yield { status: TxStatus.Failed, error: createError(err) };
        return;
      }

      let failure: TxStatusEvent<CreatedProcess> | undefined;
      const stream = this.newProcess(
        { ...rest, dkg: dkgParams },
        dkg ? {} : { expectedProcessId: pid }
      );
      for await (const event of stream) {
        if (event.status === TxStatus.Completed) {
          const response = {
            ...event.response,
            ...(secret !== undefined && { organizerSecret: secret }),
          };
          yield { status: TxStatus.Completed, response };
          return;
        }
        if (event.status === TxStatus.Pending) yield event;
        else failure = event;
      }
      if (!failure) return;
      if (attempt === 0 && dkg && (await this.dkgRetryable(failure, dkgParams, locked))) continue;
      yield failure;
      return;
    }
  }

  // The pool emptied, or (locked mode) a new epoch went live under us.
  private async dkgRetryable(
    failure: TxStatusEvent<CreatedProcess>,
    sent: DkgParams,
    locked: boolean
  ): Promise<boolean> {
    const error =
      failure.status === TxStatus.Failed || failure.status === TxStatus.Reverted
        ? failure.error
        : undefined;
    if (error instanceof ContractServiceError && error.revertName === 'PoolExhausted') return true;
    if (!locked) return false;
    try {
      return (await this.getRegistrationEpoch()) !== sent.epochId;
    } catch {
      return false;
    }
  }

  /**
   * `setProcessStatus`. ENDED needs the start to have passed (before it,
   * cancel instead) and moves an end still ahead to now; PAUSED only before
   * the end; CANCELED from READY or PAUSED at any time.
   */
  setProcessStatus(processId: string, newStatus: ProcessStatus) {
    return this.writeDone(
      'setProcessStatus',
      () => [normalizePid(processId), newStatus],
      ProcessStatusError
    );
  }

  /**
   * Replaces the census of an off-chain dynamic (origin 2) process, READY or
   * PAUSED, before its end. Other origins fail with {@link CensusNotUpdatable}.
   */
  setProcessCensus(processId: string, newCensus: RegistryCensus) {
    const method = 'setProcessCensus';
    return this.write(
      method,
      () => [normalizePid(processId), census(newCensus)],
      (message, revert, cause) =>
        revert?.name === 'CensusNotUpdatable'
          ? new CensusNotUpdatable(message, method, revert, cause)
          : new ProcessCensusError(message, method, revert, cause),
      () => ({ success: true })
    );
  }

  /**
   * Replaces the metadata URI and hash (READY or PAUSED, before the end).
   * `hash` is `metadataHash()` of the exact bytes served at `uri`.
   */
  setProcessMetadata(processId: string, uri: string, hash: string) {
    return this.writeDone(
      'setProcessMetadata',
      () => [normalizePid(processId), uri, hash],
      ProcessMetadataError
    );
  }

  /**
   * Sets the duration from the start time (READY or PAUSED, before the
   * current end). Extending is free; a shorter end must still be in the
   * future and at least `noticeMin` from now, else `InvalidDuration`. See
   * {@link closeProcessIn}.
   */
  setProcessDuration(processId: string, duration: bigint | number) {
    return this.writeDone(
      'setProcessDuration',
      () => [normalizePid(processId), unsigned(duration, 'duration')],
      ProcessDurationError
    );
  }

  /**
   * Shortens a running process so it ends `seconds` from the chain head,
   * never sooner than the registry's `noticeMin`, plus `slack` for the
   * transaction's own inclusion (the notice is checked at inclusion time).
   * Nodes flush during the notice; results follow the grace window. The new
   * end must fall between the start and the current end: a process that
   * would close before it starts is refused (cancel it instead).
   *
   * @param options - `slack` in seconds (default {@link SHORTEN_SLACK_SECONDS})
   */
  async *closeProcessIn(
    processId: string,
    seconds: number,
    options: { slack?: number } = {}
  ): AsyncGenerator<TxStatusEvent<{ success: boolean; duration: bigint }>, void, unknown> {
    let pid: string;
    let duration: bigint;
    try {
      pid = normalizePid(processId);
      const [process, grace, head] = await Promise.all([
        this.getProcess(pid),
        this.getGraceParams(),
        this.provider().getBlock('latest'),
      ]);
      if (!head) throw new Error('no latest block');
      const asked = wholeSeconds(seconds, 'seconds');
      const notice = asked > BigInt(grace.noticeMin) ? asked : BigInt(grace.noticeMin);
      const slack = wholeSeconds(options.slack ?? SHORTEN_SLACK_SECONDS, 'slack');
      const end = BigInt(head.timestamp) + notice + slack;
      if (end >= process.startTime + process.duration) {
        throw new Error('the process already ends by then');
      }
      if (end <= process.startTime) {
        throw new Error(
          `process ${pid} starts at ${when(process.startTime)} and cannot close before it ` +
            'starts; cancel it, or close it later'
        );
      }
      duration = end - process.startTime;
    } catch (err) {
      yield {
        status: TxStatus.Failed,
        error:
          err instanceof ContractServiceError
            ? err
            : new ProcessDurationError(
                `closeProcessIn: ${errorText(err)}`,
                'closeProcessIn',
                undefined,
                err
              ),
      };
      return;
    }
    yield* this.write(
      'setProcessDuration',
      () => [pid, duration],
      errorsOf(ProcessDurationError, 'setProcessDuration'),
      () => ({ success: true, duration })
    );
  }

  /**
   * Sets max voters (READY or PAUSED, before the end), never below the
   * voters counted and within `maxValue <= 1e12 / maxVoters`.
   */
  setProcessMaxVoters(processId: string, maxVoters: bigint | number) {
    return this.writeDone(
      'setProcessMaxVoters',
      () => [normalizePid(processId), BigInt(maxVoters)],
      ProcessMaxVotersError
    );
  }

  /**
   * Sets the idle grace window after the end (READY or PAUSED, before the
   * end), within the registry's `graceFloor..graceCeil`, else `InvalidGrace`.
   */
  setProcessGrace(processId: string, grace: number) {
    return this.writeDone(
      'setProcessGrace',
      () => [normalizePid(processId), grace],
      ProcessGraceError
    );
  }

  /**
   * Publishes the organizer secret of a DKG-locked process, after which the
   * committee decrypts the tally. A wrong secret reverts `InvalidOrganizerSecret`.
   */
  revealProcessKey(processId: string, secret: bigint) {
    return this.writeDone(
      'revealProcessKey',
      () => [normalizePid(processId), secret],
      ProcessKeyRevealError
    );
  }

  /**
   * Permissionless nudge that reads the committee's plaintexts into the
   * results of a DKG process, once the grace window closed and the
   * decryption was requested (else `GraceOpen` or `ResultsNotReady`).
   */
  finalizeResultsFromDKG(processId: string) {
    return this.writeDone(
      'finalizeResultsFromDKG',
      () => [normalizePid(processId)],
      ProcessResultError
    );
  }

  // ─── EVENT LISTENERS ───────────────────────────────────────────────────────

  onProcessCreated(cb: ProcessCreatedCallback): void {
    this.setupEventListener<[string, string]>(this.contract, 'ProcessCreated', cb).catch(err =>
      console.error('Error setting up ProcessCreated listener:', err)
    );
  }

  onProcessStatusChanged(cb: ProcessStatusChangedCallback): void {
    this.setupEventListener<[string, bigint, bigint]>(
      this.contract,
      'ProcessStatusChanged',
      cb
    ).catch(err => console.error('Error setting up ProcessStatusChanged listener:', err));
  }

  onCensusUpdated(cb: ProcessCensusUpdatedCallback): void {
    this.setupEventListener<[string, string, string]>(this.contract, 'CensusUpdated', cb).catch(
      err => console.error('Error setting up CensusUpdated listener:', err)
    );
  }

  onProcessMetadataUpdated(cb: ProcessMetadataUpdatedCallback): void {
    this.setupEventListener<[string, string, string]>(
      this.contract,
      'ProcessMetadataUpdated',
      cb
    ).catch(err => console.error('Error setting up ProcessMetadataUpdated listener:', err));
  }

  onProcessDurationChanged(cb: ProcessDurationChangedCallback): void {
    this.setupEventListener<[string, bigint]>(this.contract, 'ProcessDurationChanged', cb).catch(
      err => console.error('Error setting up ProcessDurationChanged listener:', err)
    );
  }

  onProcessGraceChanged(cb: ProcessGraceChangedCallback): void {
    this.setupEventListener<[string, bigint]>(this.contract, 'ProcessGraceChanged', cb).catch(err =>
      console.error('Error setting up ProcessGraceChanged listener:', err)
    );
  }

  onStateTransitioned(cb: ProcessStateTransitionedCallback): void {
    this.setupEventListener<[string, string, string, string, bigint, bigint, bigint]>(
      this.contract,
      'ProcessStateTransitioned',
      cb
    ).catch(err => console.error('Error setting up ProcessStateTransitioned listener:', err));
  }

  onProcessResultsSet(cb: ProcessResultsSetCallback): void {
    this.setupEventListener<[string, string, bigint[]]>(
      this.contract,
      'ProcessResultsSet',
      cb
    ).catch(err => console.error('Error setting up ProcessResultsSet listener:', err));
  }

  onResultsDecryptionRequested(cb: ResultsDecryptionRequestedCallback): void {
    this.setupEventListener<[string, string, string, bigint, bigint]>(
      this.contract,
      'ResultsDecryptionRequested',
      cb
    ).catch(err => console.error('Error setting up ResultsDecryptionRequested listener:', err));
  }

  onProcessMaxVotersChanged(cb: ProcessMaxVotersChangedCallback): void {
    this.setupEventListener<[string, bigint]>(this.contract, 'ProcessMaxVotersChanged', cb).catch(
      err => console.error('Error setting up ProcessMaxVotersChanged listener:', err)
    );
  }

  removeAllListeners(): void {
    void this.contract.removeAllListeners();
    this.clearPollingIntervals();
  }
}
