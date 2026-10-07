import { getAddress, type Provider, type Signer } from 'ethers';
import { VocdoniApiService } from './core/api/ApiService';
import type { BaseServiceConfig } from './core/api/BaseService';
import type { DocumentOptions, Uploader } from './core/types/uploader';
import { ProcessRegistryService } from './contracts/ProcessRegistryService';
import { DeploymentPinError } from './contracts/errors';
import { SmartContractService, type TxStatusEvent } from './contracts/SmartContractService';
import type { GraceParams } from './contracts/types';
import {
  ProcessOrchestrationService,
  ProcessConfig,
  ProcessCreationResult,
  ProcessInfo,
  type CancelOpenProcessesOptions,
  type CancelOpenProcessesResult,
  type CensusUpdate,
  type CloseProcessOptions,
  type DurationChange,
  type MetadataUpdate,
} from './core/process';
import {
  VoteOrchestrationService,
  type ProcessResults,
  type ResultsStatus,
  type VoteConfig,
  type VoteReceipt,
  type VoteResult,
  type VoteStatusInfo,
  type VoteStatusWaitOptions,
  type WaitForResultsOptions,
} from './core/vote';
import { VoteStatus, type SequencerInfo } from './sequencer/api/types';
import { checkNodeInfo, type NodeExpectation } from './sequencer/api/helpers';
import { SequencerApiError, SequencerNetworkError, SequencerError } from './sequencer/errors';
import { VocdoniSequencerService } from './sequencer/SequencerService';
import { CensusProviders } from './census/types';
import {
  FailoverRpcProvider,
  networkOfProcessId,
  processIdPrefixOf,
  resolveNetwork,
  type CustomNetwork,
  type ResolvedNetwork,
} from './networks';
import type { RELEASE_PINS } from './protocol/release';
import { BallotProver, type BallotProof, type ProvableBallot } from './prover/BallotProver';
import { checkArtifactsConfig, type ArtifactsConfig } from './prover/artifacts';

/** Pins to check a deployment against instead of this release's (a local deployment). */
export type DeploymentPins = Partial<Record<keyof typeof RELEASE_PINS, string>>;

/**
 * Configuration of a {@link DavinciSDK}. Only `signer` and the sequencer node
 * URLs are required; the network defaults to Gnosis.
 */
export interface DavinciSDKConfig {
  /**
   * Signs votes, and transactions for organizer work. A voter can use a bare
   * `Wallet`; an organizer's signer needs a provider on the network's chain.
   */
  signer: Signer;

  /**
   * The deployment: a known network by name (default `'gnosis'`), or a custom
   * one, `{ chainId, processRegistry, startBlock?, rpcUrls? }`.
   */
  network?: string | CustomNetwork;

  /**
   * Base URLs of the deployment's sequencer nodes. Votes are routed among them
   * per voter, with failover; reads ask them in order. The SDK embeds none.
   */
  sequencerUrls?: readonly string[];

  /**
   * The node that issues the encryption key of a sequencer-key election, and
   * later publishes its results. Default: the first usable node of
   * `sequencerUrls`.
   */
  keySequencerUrl?: string;

  /**
   * JSON-RPCs for registry reads, in order of preference. Default: the
   * signer's provider when it is on the network's chain, else the network's
   * RPCs.
   */
  rpcUrls?: readonly string[];

  /** Publishes census files and metadata documents; the SDK ships no hosting. */
  uploader?: Uploader;

  /**
   * How census files and metadata documents are downloaded and checked:
   * `fetchImpl`, `timeoutMs`, `verify` (read back what is published, default
   * true) and `allowPrivateHosts` (local development).
   */
  documents?: DocumentOptions;

  /** Where the ballot circuit files come from; default the pinned table URLs. */
  artifacts?: ArtifactsConfig;

  /**
   * Checks at init that the registry pins what this release proves and
   * verifies (`ProcessRegistryService.verifyDeployment`): the program vks, the
   * vadcop root, the ballot VK hash, the verifier's code and the DKG adapter.
   * Default true; `{ pins }` checks other pins (a local deployment), false
   * skips the check.
   */
  verifyDeployment?: boolean | { pins: DeploymentPins };

  /** Verify every ballot proof locally before it is used; default true. */
  verifyProof?: boolean;

  /** Headers, `fetchImpl`, timeout and body cap of the sequencer clients. */
  sequencerConfig?: BaseServiceConfig;

  /** Census witness providers for voting (a CSP's attestations, a custom Merkle source). */
  censusProviders?: CensusProviders;

  /**
   * @deprecated Ignored: there is no census service. Merkle censuses are
   * published through `uploader`.
   */
  censusUrl?: string;

  /** @deprecated Use `sequencerUrls`; this URL is added to them. */
  sequencerUrl?: string;

  /**
   * @deprecated Use `network: { chainId, processRegistry }`. The registry of a
   * custom deployment, on the chain the read RPC serves.
   */
  addresses?: {
    processRegistry?: string;
  };

  /** @deprecated Ignored: circuit files are always checked against their pinned sha256. */
  verifyCircuitFiles?: boolean;
}

/** The settings a {@link DavinciSDK} runs with, defaults applied. */
export interface DavinciSDKSettings {
  /** The deployment; for the deprecated `addresses` form, known after `init()`. */
  network?: ResolvedNetwork;
  /** Vote and read nodes, as configured. */
  sequencerUrls: readonly string[];
  keySequencerUrl?: string;
  rpcUrls?: readonly string[];
  verifyDeployment: boolean | { pins: DeploymentPins };
  verifyProof: boolean;
}

/** What `init()` found at a configured sequencer node. */
export interface NodeCheck {
  url: string;
  /**
   * `usable`; `observer` (it takes no votes and issues no keys); or `down`:
   * no answer, or a 408, 429 or 5xx. Nodes that are not usable are left out
   * for the session.
   */
  status: 'usable' | 'observer' | 'down';
  /** Its `/info`, when it answered; it matched the deployment, or `init()` failed. */
  info?: SequencerInfo;
  /** Why it is not used, for an observer or a node that is down. */
  reason?: string;
}

// Errors that say the node is down or busy rather than not a sequencer.
function unreachable(err: unknown): boolean {
  return (
    err instanceof SequencerNetworkError ||
    (err instanceof SequencerApiError &&
      (err.status >= 500 || err.status === 408 || err.status === 429))
  );
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Freezes plain data (objects and arrays) all the way down.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * The DAVINCI SDK: one deployment (a registry on a chain) and its sequencer
 * nodes. `init()` resolves the network, builds the read provider, checks the
 * registry pins (unless disabled) and checks every node's `/info` against the
 * registry; everything else needs it first.
 *
 * @example
 * ```typescript
 * const sdk = new DavinciSDK({
 *   signer: wallet,
 *   network: 'gnosis',
 *   sequencerUrls: ['https://sequencer-1.example.org', 'https://sequencer-2.example.org'],
 * });
 * await sdk.init();
 * ```
 */
export class DavinciSDK {
  private readonly settings: DavinciSDKSettings;
  private readonly signer: Signer;
  private readonly uploaderImpl?: Uploader;
  private readonly documents: DocumentOptions;
  private readonly artifactsConfig?: ArtifactsConfig;
  private readonly sequencerConfig?: BaseServiceConfig;
  // The registry of the deprecated `addresses` form, before its chain is known.
  private readonly aliasRegistry?: string;
  private _network?: ResolvedNetwork;
  private apiService?: VocdoniApiService;
  private readProvider?: Provider;
  private _registry?: ProcessRegistryService;
  private _processRegistry?: ProcessRegistryService;
  private _processOrchestrator?: ProcessOrchestrationService;
  private _readOrchestrator?: ProcessOrchestrationService;
  private _voteOrchestrator?: VoteOrchestrationService;
  private _ballotProver?: BallotProver;
  // What the registry pins, which every node must report.
  private registryPins?: NodeExpectation;
  private _nodeChecks: readonly NodeCheck[] = [];
  // The signer provider's chain as init() saw it; undefined without a provider.
  private signerChainId?: bigint;
  private initialized = false;
  private initializing?: Promise<void>;
  private censusProviders: CensusProviders;

  /**
   * Reads and checks the configuration; nothing is fetched until `init()`.
   * Later changes to `config` do not reach the SDK.
   *
   * @throws Error for an unknown network, no sequencer URL, or a deprecated
   *   `addresses.processRegistry` that contradicts `network`
   * @throws ArtifactError for a malformed `artifacts` table or timeout
   */
  constructor(config: DavinciSDKConfig) {
    const sequencerUrls = [
      ...new Set([
        ...(config.sequencerUrls ?? []),
        ...(config.sequencerUrl ? [config.sequencerUrl] : []),
      ]),
    ];
    if (sequencerUrls.length === 0 && !config.keySequencerUrl) {
      throw new Error(
        "sequencerUrls is required: the base URLs of the deployment's sequencer nodes"
      );
    }
    checkArtifactsConfig(config.artifacts);
    const alias = config.addresses?.processRegistry;
    if (config.network !== undefined || alias === undefined) {
      this._network = deepFreeze(resolveNetwork(config.network ?? 'gnosis'));
      if (alias !== undefined && getAddress(alias) !== this._network.processRegistry) {
        throw new Error(
          `addresses.processRegistry ${alias} is not the ${this._network.name} registry ${this._network.processRegistry}`
        );
      }
    } else {
      this.aliasRegistry = getAddress(alias);
    }
    this.signer = config.signer;
    this.uploaderImpl = config.uploader;
    const timeoutMs = config.documents?.timeoutMs;
    if (timeoutMs !== undefined && !(typeof timeoutMs === 'number' && timeoutMs > 0)) {
      throw new Error(`documents.timeoutMs ${String(timeoutMs)} is not a positive number`);
    }
    this.documents = { ...config.documents };
    this.artifactsConfig = config.artifacts;
    this.sequencerConfig = config.sequencerConfig;
    this.censusProviders = config.censusProviders || {};
    const verify = config.verifyDeployment ?? true;
    this.settings = {
      network: this._network,
      sequencerUrls: deepFreeze(sequencerUrls),
      keySequencerUrl: config.keySequencerUrl,
      rpcUrls: config.rpcUrls && deepFreeze([...config.rpcUrls]),
      verifyDeployment:
        typeof verify === 'boolean' ? verify : deepFreeze({ pins: { ...verify.pins } }),
      verifyProof: config.verifyProof ?? true,
    };
  }

  /**
   * Connects the SDK to its deployment; call it once before anything else.
   *
   * 1. Picks the read provider: `rpcUrls`, else the signer's provider when it
   *    is on the network's chain, else the network's RPCs.
   * 2. Reads the registry, which must report the network's chain id.
   * 3. Unless `verifyDeployment` is false, checks the registry pins.
   * 4. Asks every node for `/info`: a node of another chain, registry, ballot
   *    VK or program vk fails `init()` (`NodeMismatchError`), and so does a
   *    URL that answers but is not a sequencer. Observers and nodes that are
   *    down (no answer, or a 408, 429 or 5xx) are recorded in
   *    {@link nodeChecks} and left out for the session. `init()` succeeds
   *    even with none left, so organizer work that needs no node goes on;
   *    a call that needs a node then fails with `SequencerUnavailableError`
   *    naming the nodes left out and why.
   *
   * @throws Error, DeploymentPinError or NodeMismatchError naming what does not match
   */
  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.initializing ??= this.connect().catch((err: unknown) => {
      this.initializing = undefined;
      throw err;
    });
    return this.initializing;
  }

  private async connect(): Promise<void> {
    const provider = await this.pickReadProvider();
    const network =
      this._network ??
      resolveNetwork({
        chainId: Number((await provider.getNetwork()).chainId),
        processRegistry: this.aliasRegistry as string,
      });
    const registry = new ProcessRegistryService(network.processRegistry, provider);

    let chain: string;
    try {
      chain = await registry.getChainID();
    } catch (err) {
      throw new Error(
        `cannot read the ${network.name} ProcessRegistry at ${network.processRegistry} ` +
          `(is the read RPC on chain ${network.chainId}?): ${message(err)}`
      );
    }
    if (chain !== String(network.chainId)) {
      throw new DeploymentPinError('chainID', String(network.chainId), chain);
    }
    const [ballotVkHash, batchProgramVk, resultsProgramVk] = await Promise.all([
      registry.getBallotVKHash(),
      registry.getBatchProgramVK(),
      registry.getResultsProgramVK(),
    ]);
    const verify = this.settings.verifyDeployment;
    if (verify !== false) {
      await registry.verifyDeployment(verify === true ? {} : verify.pins);
    }
    const pins: NodeExpectation = {
      chainId: network.chainId,
      processRegistry: network.processRegistry,
      ballotVkHash,
      batchProgramVk,
      resultsProgramVk,
    };
    const checks = await this.checkNodes(pins);
    const signerChainId = this.signer.provider
      ? await this.signer.provider.getNetwork().then(
          n => n.chainId,
          () => undefined
        )
      : undefined;

    const { sequencerUrls, keySequencerUrl } = this.settings;
    this.apiService = new VocdoniApiService({
      sequencerURLs: sequencerUrls,
      keySequencerURL: keySequencerUrl,
      sequencerConfig: this.sequencerConfig,
      unusable: checks.flatMap(c =>
        c.reason === undefined ? [] : [{ url: c.url, reason: c.reason }]
      ),
    });
    this._network = deepFreeze(network);
    this.settings.network = this._network;
    this.readProvider = provider;
    this._registry = registry;
    this.registryPins = pins;
    this._nodeChecks = deepFreeze(checks);
    this.signerChainId = signerChainId;
    this.initialized = true;
  }

  // `rpcUrls`, else the signer's provider on the network's chain, else the network's RPCs.
  private async pickReadProvider(): Promise<Provider> {
    const net = this._network;
    const rpcUrls = this.settings.rpcUrls;
    if (rpcUrls && rpcUrls.length > 0) return new FailoverRpcProvider(rpcUrls, net?.chainId);
    const own = this.signer.provider;
    if (own) {
      if (!net) return own;
      const { chainId } = await own.getNetwork();
      if (chainId === BigInt(net.chainId)) return own;
    }
    if (net && net.rpcUrls.length > 0) return new FailoverRpcProvider(net.rpcUrls, net.chainId);
    const where = net ? `the ${net.name} registry (chain ${net.chainId})` : 'the registry';
    throw new Error(
      `no RPC to read ${where}: set rpcUrls, or connect the signer to a provider on that chain`
    );
  }

  // Every configured node's /info against the registry. A node of another
  // deployment, or a URL that is not a sequencer, fails init; one that is
  // down or an observer is recorded and left out.
  private async checkNodes(pins: NodeExpectation): Promise<NodeCheck[]> {
    const { sequencerUrls, keySequencerUrl } = this.settings;
    const urls = [...new Set([...sequencerUrls, ...(keySequencerUrl ? [keySequencerUrl] : [])])];
    return Promise.all(
      urls.map(async (url): Promise<NodeCheck> => {
        let info: SequencerInfo;
        try {
          info = await new VocdoniSequencerService(url, this.sequencerConfig).getInfo();
        } catch (err) {
          if (unreachable(err)) return { url, status: 'down', reason: `down: ${message(err)}` };
          if (err instanceof SequencerError) {
            throw new SequencerError(`sequencer ${url}: /info: ${err.message}`, url);
          }
          throw err;
        }
        checkNodeInfo(info, pins, url);
        return info.observer
          ? { url, status: 'observer', info, reason: 'observer' }
          : { url, status: 'usable', info };
      })
    );
  }

  private requireInit(what: string): void {
    if (!this.initialized) {
      throw new Error(`SDK must be initialized before ${what}. Call sdk.init() first.`);
    }
  }

  /**
   * The sequencer clients: `sequencer` issues keys, `nodes` routes votes and
   * reads. Available after `init()`, with the nodes that passed its checks;
   * a role with no usable node throws `SequencerUnavailableError` naming the
   * nodes left out.
   */
  get api(): VocdoniApiService {
    this.requireInit('using the sequencer API');
    return this.apiService as VocdoniApiService;
  }

  /** The deployment the SDK works with; after `init()`. */
  get network(): ResolvedNetwork {
    this.requireInit('reading the network');
    return this._network as ResolvedNetwork;
  }

  /** What `init()` found at each configured sequencer node. */
  get nodeChecks(): readonly NodeCheck[] {
    return this._nodeChecks;
  }

  /** The provider registry reads go through (see `rpcUrls`); after `init()`. */
  get provider(): Provider {
    this.requireInit('reading the chain');
    return this.readProvider as Provider;
  }

  /** The configured uploader, if any. */
  get uploader(): Uploader | undefined {
    return this.uploaderImpl;
  }

  /**
   * The registry for reads, through the read provider; after `init()`. Voters
   * read election parameters here, never from a sequencer.
   */
  get registry(): ProcessRegistryService {
    this.requireInit('reading the registry');
    return this._registry as ProcessRegistryService;
  }

  /**
   * The network's registry with the signer as runner, for organizer writes;
   * after `init()`. The signer's provider must be on the network's chain, as
   * `init()` saw it. This raw service does not re-check the signer's chain
   * or the process id prefix on each write, as the facade methods do.
   *
   * @throws Error before `init()`, without a signer provider, or with the
   *   signer on another chain
   */
  get processes(): ProcessRegistryService {
    this.requireInit('using the process registry');
    this.ensureProvider();
    const network = this.network;
    if (this.signerChainId !== undefined && this.signerChainId !== BigInt(network.chainId)) {
      throw new Error(
        `The signer is on chain ${this.signerChainId}; the ${network.name} registry is on chain ${network.chainId}.`
      );
    }
    this._processRegistry ??= new ProcessRegistryService(network.processRegistry, this.signer);
    return this._processRegistry;
  }

  /** The ballot prover, with the configured artifacts and `verifyProof`. */
  get ballotProver(): BallotProver {
    this._ballotProver ??= new BallotProver({
      artifacts: this.artifactsConfig,
      verifyProof: this.settings.verifyProof,
    });
    return this._ballotProver;
  }

  /**
   * Proves a built ballot (`buildBallot`) under the registry's ballot VK:
   * the circuit files are downloaded once and checked, and the proof must
   * carry the ballot's public signals.
   *
   * @throws ArtifactError or BallotProofError
   */
  async proveBallot(ballot: ProvableBallot): Promise<BallotProof> {
    this.requireInit('proving ballots');
    return this.ballotProver.prove(ballot, (this.registryPins as NodeExpectation).ballotVkHash);
  }

  /**
   * The organizer's side, after `init()`: process creation and the organizer
   * controls, sent from the signer.
   *
   * @throws Error if the signer has no provider
   */
  get processOrchestrator(): ProcessOrchestrationService {
    this.requireInit('creating or managing processes');
    this.ensureProvider();
    this._processOrchestrator ??= new ProcessOrchestrationService(
      this.processes,
      this.api,
      this.signer,
      { uploader: this.uploaderImpl, documents: this.documents }
    );
    return this._processOrchestrator;
  }

  // Process reads through the read provider: no signer provider needed.
  private get readOrchestrator(): ProcessOrchestrationService {
    this._readOrchestrator ??= new ProcessOrchestrationService(
      this.registry,
      this.api,
      this.signer,
      { documents: this.documents }
    );
    return this._readOrchestrator;
  }

  /**
   * The voter's side, after `init()`: votes, their status and receipts,
   * census membership and results. It reads the registry through the read
   * provider and proves with {@link ballotProver}.
   */
  get voteOrchestrator(): VoteOrchestrationService {
    this.requireInit('voting');
    this._voteOrchestrator ??= new VoteOrchestrationService(this.registry, this.api, this.signer, {
      prove: ballot => this.proveBallot(ballot),
      provider: this.provider,
      censusProviders: this.censusProviders,
      documents: this.documents,
      writer: () => this.processes,
    });
    return this._voteOrchestrator;
  }

  /**
   * A process as the registry stores it, in the shape of the config it was
   * created with plus its runtime state.
   *
   * The metadata document is downloaded and checked against the registry's
   * `metadataHash`: title, description and questions come from it only when
   * it matches (`metadataVerified`, `metadataStatus`). The key mode, the
   * grace window (`grace`, `lastVoteAt`, `graceEnd`) and the `phase`
   * (`upcoming`, `open`, `paused`, `closing`, `ended`, `results`, `canceled`)
   * come from the same registry read and the chain head's time.
   *
   * Reads through the SDK's read provider: a voter's bare wallet is enough.
   *
   * @param processId - A process id of the network's registry
   * @throws Error for a process id of another registry
   *
   * @example
   * ```typescript
   * const info = await sdk.getProcess(processId);
   * if (info.metadataVerified) console.log(info.title, info.questions);
   * console.log(info.status, info.phase, info.endDate, info.graceEnd); // 'closing' until graceEnd
   * console.log(info.raw); // the registry's struct
   * ```
   */
  async getProcess(processId: string): Promise<ProcessInfo> {
    this.requireInit('getting processes');
    this.checkProcessId(processId);
    return this.readOrchestrator.getProcess(processId);
  }

  /**
   * Creates a process and returns an async generator of its transaction's
   * status events (`pending`, `completed`, `failed`, `reverted`).
   *
   * 1. The config is checked against the registry and the ballot circuit:
   *    the timing on the chain clock (no `startDate` starts it in the block
   *    that creates it), the ballot mode (at most 16 fields, values below
   *    2^48, sums below 2^63), `maxVoters` and the result cap
   *    (`maxValue * maxVoters <= 1e12`), and for a DKG key that the registry
   *    has a DKG adapter.
   * 2. A Merkle census object and the metadata document are published through
   *    the configured `uploader` and read back as nodes and readers will; a
   *    census or a document given by URL is checked the same way.
   * 3. One creation at a time per account: the id the registry assigns next
   *    is read, a `'sequencer'` key is asked from the key node for that id,
   *    and `newProcess` is simulated, then sent. A DKG creation is retried
   *    once when the committee's key pool ran out or the epoch moved (a
   *    second `pending`). With `paused` the process is created PAUSED.
   * 4. With `grace`, `setProcessGrace` follows as its own step: a `pending`
   *    event with `step: 'setProcessGrace'`, then `completed` with `grace`,
   *    or `graceError` if only that transaction failed (the process exists).
   *    A value outside the registry's `graceFloor..graceCeil` is refused in
   *    step 1, before anything is created. A live meeting sets the floor
   *    (`getGraceParams`) so results follow the close within minutes.
   *
   * The key mode (`keyMode`) decides who can decrypt the results:
   * `'sequencer'` (default) the key node, `'dkg'` a davinci-dkg committee,
   * `'dkg-locked'` the committee once the organizer reveals the secret
   * returned in `organizerSecret`, and `'council'` the invite-only committee
   * of the Council ceremony in `ceremonyId`. Results come after the grace
   * window that follows the end.
   *
   * Refusals come as `failed` events: a `ProcessCreateError` (with the
   * registry error in `revertName`), `DkgDisabledError`,
   * `CouncilDisabledError`, a census, metadata or sequencer error, or `WrongProcessIdError` when another creation from the
   * same account took the key's id (cancel that process, see
   * `cancelOpenProcesses`). Requires a signer with a provider on the
   * network's chain.
   *
   * @param config - Process configuration
   * @returns AsyncGenerator yielding transaction status events
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, or the signer has no provider or is on another chain.
   *   Refusals of the creation itself come as `Failed` events.
   *
   * @example
   * ```typescript
   * const census = new OffchainCensus();
   * census.add(['0x1111…', '0x2222…']);
   * const stream = sdk.createProcessStream({
   *   title: 'My Election',
   *   description: 'A simple election',
   *   census,
   *   electionPreset: { type: 'single_choice' },
   *   timing: { duration: 3600 * 24 },
   *   questions: [
   *     {
   *       title: 'What is your favorite color?',
   *       choices: [
   *         { title: 'Red', value: 0 },
   *         { title: 'Blue', value: 1 },
   *       ],
   *     },
   *   ],
   * });
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log('Transaction pending:', event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log('Process created:', event.response.processId);
   *       break;
   *     case TxStatus.Failed:
   *     case TxStatus.Reverted:
   *       console.error('Creation failed:', event.error);
   *       break;
   *   }
   * }
   * ```
   */
  createProcessStream(config: ProcessConfig): AsyncGenerator<TxStatusEvent<ProcessCreationResult>> {
    return this.organizerStream('creating processes', undefined, o =>
      o.createProcessStream(config)
    );
  }

  /**
   * {@link createProcessStream}, waiting for the transaction.
   *
   * @param config - Process configuration
   * @returns The process id, the transaction hash and, for `'dkg-locked'`,
   *   the organizer secret: store it, the SDK keeps no copy and the results
   *   never unlock without it
   * @throws the stream's failure (see {@link createProcessStream})
   *
   * @example
   * ```typescript
   * // A committee-held key whose results stay locked until the organizer says so.
   * const { processId, organizerSecret, graceError } = await sdk.createProcess({
   *   title: 'Board election',
   *   census,
   *   electionPreset: { type: 'multiple_choice', maxSelections: 2 },
   *   timing: { startDate: '2026-12-07T09:00:00Z', endDate: '2026-12-08T18:00:00Z' },
   *   questions,
   *   keyMode: 'dkg-locked',
   *   grace: 150, // seconds, within the registry's graceFloor..graceCeil
   * });
   * ```
   */
  async createProcess(config: ProcessConfig): Promise<ProcessCreationResult> {
    return SmartContractService.executeTx(this.createProcessStream(config));
  }

  /**
   * Casts a vote for the signer. A bare `Wallet` is enough: the election is
   * read through the SDK's read provider.
   *
   * 1. The process is read from the registry (never from a node) and must
   *    take votes: from its start to its end, READY or PAUSED (a paused
   *    process's votes settle once it resumes). It is cross-checked with the
   *    view of the voter's node.
   * 2. The voter's census witness: the nodes' proof for a static or
   *    updatable Merkle census (at the registry's root), the census
   *    contract's weight for an on-chain census, or the CSP's attestation
   *    from `censusProviders.csp` for a CSP census.
   * 3. The choices are checked against the ballot mode, then the 16-field
   *    ballot is built under the registry's key, proved (the circuit files
   *    are downloaded once and checked) and its vote id signed.
   * 4. It goes to the voter's node (`pickNode`), failing over only when that
   *    is safe. A revote goes to the node that took the voter's previous
   *    ballot, so it queues behind it. This SDK remembers that node in memory
   *    only: an app that reloads, or revotes from another tab or device,
   *    stores {@link VoteResult.node} and passes it back as `node`.
   *
   * Nodes batch votes, so a vote is `pending` for a while (minutes to a
   * quarter of an hour on default nodes, until shortly before the end);
   * follow it with {@link watchVoteStatus}.
   *
   * @param config - The process, the choices (one value per ballot field),
   *   and optionally the previous ballot's node and the ballot secret `k`
   *   (random by default; a given one must be a random field element used
   *   for no other ballot, revotes included, and one below 2^128 is refused)
   * @returns The vote id, the node that took it, the weight, and the ballot
   *   secret `k` (it opens the ballot: keep it private)
   * @throws VoteError with a `reason`: `not-in-census`, `not-started`,
   *   `closed`, `invalid` (choices outside the ballot mode, or a protocol
   *   check), `duplicate`, `slot-busy` (retry once the voter's queued ballots
   *   settle), `max-voters`, `busy` (retry shortly), `unavailable`
   * @throws RangeError for a ballot secret `k` below 2^128
   * @throws CensusWitnessError for a CSP census without `censusProviders.csp`,
   *   or an attestation that is not the voter's
   * @throws ArtifactError or BallotProofError when the ballot cannot be proved
   *
   * @example
   * ```typescript
   * const vote = await sdk.submitVote({ processId, choices: [0, 1, 0] });
   * console.log(vote.voteId, vote.node);
   * try {
   *   await sdk.submitVote({ processId, choices: [1, 0, 0] }); // a revote
   * } catch (err) {
   *   if (err instanceof VoteError && err.reason === 'slot-busy') {
   *     // the earlier ballots are still queued: try again later
   *   }
   * }
   * ```
   */
  async submitVote(config: VoteConfig): Promise<VoteResult> {
    this.requireInit('submitting votes');
    this.checkProcessId(config.processId);
    return this.voteOrchestrator.submitVote(config);
  }

  /**
   * The status of a vote and the node that reports it: the node that took
   * it is asked first. A vote in `error` carries the node's reason (`process
   * closed`, `census changed, recast`, a guest check).
   *
   * @param processId - The process ID
   * @param voteId - The vote ID returned from submitVote()
   * @param node - The node that took the vote; default the one this SDK sent it to
   *
   * @example
   * ```typescript
   * const { status, error, node } = await sdk.getVoteStatus(processId, voteId);
   * // "pending", "aggregated", "processed", "settled" or "error"
   * ```
   */
  async getVoteStatus(processId: string, voteId: string, node?: string): Promise<VoteStatusInfo> {
    this.requireInit('getting vote status');
    this.checkProcessId(processId);
    return this.voteOrchestrator.getVoteStatus(processId, voteId, node);
  }

  /**
   * Whether a ballot sits in the address's slot: its vote settled. Every node
   * is asked. For a CSP census only the nodes that took the voter's ballot
   * know its slot, so every node must answer.
   *
   * @example
   * ```typescript
   * if (await sdk.hasAddressVoted(processId, address)) console.log('already voted');
   * ```
   */
  async hasAddressVoted(processId: string, address: string): Promise<boolean> {
    this.requireInit('checking vote status');
    this.checkProcessId(processId);
    return this.voteOrchestrator.hasAddressVoted(processId, address);
  }

  /**
   * Whether an address can vote: a member of the process's census. A Merkle
   * census is asked of the nodes (their proof must be at the registry's
   * root), an on-chain census of its contract, and a CSP census of
   * `censusProviders.csp` (its errors propagate).
   *
   * @example
   * ```typescript
   * const canVote = await sdk.isAddressAbleToVote(processId, address);
   * ```
   */
  async isAddressAbleToVote(processId: string, address: string): Promise<boolean> {
    this.requireInit('checking if address can vote');
    this.checkProcessId(processId);
    return this.voteOrchestrator.isAddressAbleToVote(processId, address);
  }

  /**
   * The census weight an address votes with; 0 for a non-member. When the
   * ballot mode's `maxValueSum` is 0 it is the voter's budget.
   *
   * @example
   * ```typescript
   * const weight = await sdk.getAddressWeight(processId, address); // bigint
   * ```
   */
  async getAddressWeight(processId: string, address: string): Promise<bigint> {
    this.requireInit('getting address weight');
    this.checkProcessId(processId);
    return this.voteOrchestrator.getAddressWeight(processId, address);
  }

  /**
   * Follows a vote's status, yielding each change, until it reaches the
   * target (default `settled`; a later step counts too) or `error`.
   *
   * By default the wait lasts until the process's grace window closes, plus
   * a few minutes: by then every vote cast before the end has settled or
   * failed (`process closed`). Nodes batch votes every few minutes to a
   * quarter of an hour, and flush them from shortly before the end.
   *
   * @throws VoteError `timeout` when the wait runs out
   *
   * @example
   * ```typescript
   * for await (const s of sdk.watchVoteStatus(processId, voteId)) {
   *   console.log(s.status, s.error ?? '');
   * }
   * ```
   */
  watchVoteStatus(
    processId: string,
    voteId: string,
    options: VoteStatusWaitOptions = {}
  ): AsyncGenerator<VoteStatusInfo> {
    this.requireInit('watching vote status');
    this.checkProcessId(processId);
    return this.voteOrchestrator.watchVoteStatus(processId, voteId, options);
  }

  /**
   * {@link watchVoteStatus}, returning the last status: the target (or a
   * later step), or `error` with its reason.
   *
   * @param targetStatus - Default `settled`
   * @param timeoutMs - Default: until the grace window closes, plus a few minutes
   * @param pollIntervalMs - Default 5 s
   * @throws VoteError `timeout` when the wait runs out
   *
   * @example
   * ```typescript
   * const final = await sdk.waitForVoteStatus(processId, voteId);
   * if (final.status === VoteStatus.Error) console.error(final.error);
   * ```
   */
  async waitForVoteStatus(
    processId: string,
    voteId: string,
    targetStatus: VoteStatus = VoteStatus.Settled,
    timeoutMs?: number,
    pollIntervalMs?: number
  ): Promise<VoteStatusInfo> {
    this.requireInit('waiting for vote status');
    this.checkProcessId(processId);
    return this.voteOrchestrator.waitForVoteStatus(processId, voteId, {
      targetStatus,
      timeoutMs,
      pollIntervalMs,
    });
  }

  /**
   * A settled vote's receipt (recorded-as-cast): a node's tracker proof that
   * the vote id is in the process's state, checked against the registry's
   * latest state root, or a root of one of its transitions.
   *
   * @param node - The node to ask first; default the one that took the vote
   * @throws VoteReceiptError when no node holds the vote yet (it has not
   *   settled), or the proof reaches no state root of the process
   *
   * @example
   * ```typescript
   * const receipt = await sdk.getVoteReceipt(processId, voteId);
   * console.log(receipt.root, receipt.latest);
   * ```
   */
  async getVoteReceipt(processId: string, voteId: string, node?: string): Promise<VoteReceipt> {
    this.requireInit('getting vote receipts');
    this.checkProcessId(processId);
    return this.voteOrchestrator.getVoteReceipt(processId, voteId, node);
  }

  /**
   * Where a process stands on the way to its results: `voting`, `grace`
   * (past the end, batches still land), `awaiting-key-holder` (a sequencer
   * key), `awaiting-request`, `locked` (a DKG-locked key not revealed),
   * `decrypting` or `finalizable` (a DKG committee), `results` (decoded in
   * `results`) or `canceled`.
   */
  async getResultsStatus(processId: string): Promise<ResultsStatus> {
    this.requireInit('reading results');
    this.checkProcessId(processId);
    return this.voteOrchestrator.getResultsStatus(processId);
  }

  /**
   * Waits for a process's results and returns them decoded per ballot kind.
   * Results unlock when the grace window after the end closes (see
   * `getGraceEnd`; every late landing pushes it out). Then the node holding a
   * sequencer key publishes them, usually within a couple of minutes, or a
   * DKG committee decrypts them in 1 to 5 more; a DKG-locked key first needs
   * the organizer's `revealProcessKey`, and a COUNCIL key its ceremony's
   * decryption opening (state `awaiting-opening`), which can be months later.
   *
   * By default it waits until the grace window closes, plus 15 minutes.
   * `finalize: true` sends the permissionless `finalizeResultsFromDKG` from
   * the signer (which pays its gas) when the committee's plaintexts are
   * ready but no node stored them.
   *
   * @throws ResultsError `canceled`, `locked` (unless `waitForReveal`) or `timeout`
   *
   * @example
   * ```typescript
   * const results = await sdk.waitForResults(processId, {
   *   onStatus: s => console.log(s.state),
   * });
   * for (const c of results.questions[0].choices) console.log(c.title, c.total);
   * ```
   */
  async waitForResults(
    processId: string,
    options: WaitForResultsOptions = {}
  ): Promise<ProcessResults> {
    this.requireInit('waiting for results');
    this.checkProcessId(processId);
    return this.voteOrchestrator.waitForResults(processId, options);
  }

  /**
   * Stores a DKG process's decrypted tally (`finalizeResultsFromDKG`) and
   * returns an async generator of transaction status events. Anyone may
   * send it once the committee's plaintexts are ready; nodes normally do
   * within seconds. The registry refuses it before the grace end
   * (`GraceOpen`), before the committee is done (`ResultsNotReady`) and, for
   * a COUNCIL process, before its ceremony opens decryption
   * (`DecryptionNotOpen`, even when every field is zero).
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals come as `Failed` events.
   */
  finalizeResultsStream(processId: string): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('finalizing results', processId, () =>
      this.processes.finalizeResultsFromDKG(processId)
    );
  }

  /**
   * {@link finalizeResultsStream}, waiting for the transaction.
   *
   * @throws ProcessResultError, with the registry error in `revertName`
   */
  async finalizeResults(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.finalizeResultsStream(processId));
  }

  // An organizer stream: init, the signer's chain and the process id checked first.
  private async *organizerStream<T>(
    what: string,
    processId: string | undefined,
    run: (orchestrator: ProcessOrchestrationService) => AsyncGenerator<TxStatusEvent<T>>
  ): AsyncGenerator<TxStatusEvent<T>> {
    this.requireInit(what);
    const orchestrator = await this.organizer(processId);
    yield* run(orchestrator);
  }

  /**
   * Ends a READY or PAUSED process (`setProcessStatus` ENDED) and returns an
   * async generator of transaction status events. Only the organizer can,
   * and only from the start on: before it the registry refuses
   * (`InvalidTimeBounds`) and `cancelProcess` is the way to void it. Before
   * the end it moves the end to now; votes already admitted still settle
   * through the grace window, and the results follow it (`getGraceEnd`).
   *
   * Every organizer control reads the process and the chain clock first and
   * refuses what the registry would revert as a `Failed` event, whose error
   * is the operation's class (`ProcessStatusError` here) with the registry
   * error in `revertName`. The call is then simulated before it is signed.
   * Requires a signer with a provider on the network's chain.
   *
   * @param processId - The process ID to end
   * @returns AsyncGenerator yielding transaction status events
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * for await (const event of sdk.endProcessStream(processId)) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process ended successfully");
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       break;
   *   }
   * }
   * ```
   */
  endProcessStream(processId: string): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('ending processes', processId, o => o.endProcessStream(processId));
  }

  /**
   * {@link endProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError (`revertName` `InvalidTimeBounds` before the start,
   *   `InvalidStatus` unless READY or PAUSED, `Unauthorized` for another account)
   *
   * @example
   * ```typescript
   * await sdk.endProcess(processId);
   * ```
   */
  async endProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.endProcessStream(processId));
  }

  /**
   * Pauses a READY process (`setProcessStatus` PAUSED) and returns an async
   * generator of transaction status events. Only before the end: from the
   * end on the registry refuses (`InvalidTimeBounds`). Nodes still take votes
   * while it is paused but settle nothing until it resumes; a process still
   * paused at its end settles through the grace window like an ended one.
   *
   * @param processId - The process ID to pause
   * @returns AsyncGenerator yielding transaction status events
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * for await (const event of sdk.pauseProcessStream(processId)) console.log(event.status);
   * ```
   */
  pauseProcessStream(processId: string): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('pausing processes', processId, o =>
      o.pauseProcessStream(processId)
    );
  }

  /**
   * {@link pauseProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError, with the registry error in `revertName`
   */
  async pauseProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.pauseProcessStream(processId));
  }

  /**
   * Cancels a READY or PAUSED process (`setProcessStatus` CANCELED) and
   * returns an async generator of transaction status events: no results will
   * be set. It works at any time, the grace window included, until a DKG
   * process's decryption was requested (which moves it to ENDED).
   *
   * @param processId - The process ID to cancel
   * @returns AsyncGenerator yielding transaction status events
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * for await (const event of sdk.cancelProcessStream(processId)) console.log(event.status);
   * ```
   */
  cancelProcessStream(processId: string): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('canceling processes', processId, o =>
      o.cancelProcessStream(processId)
    );
  }

  /**
   * {@link cancelProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError, with the registry error in `revertName`
   */
  async cancelProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.cancelProcessStream(processId));
  }

  /**
   * Resumes a PAUSED process (`setProcessStatus` READY) and returns an async
   * generator of transaction status events. Nodes then settle the votes they
   * took while it was paused.
   *
   * @param processId - The process ID to resume
   * @returns AsyncGenerator yielding transaction status events
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * for await (const event of sdk.resumeProcessStream(processId)) console.log(event.status);
   * ```
   */
  resumeProcessStream(processId: string): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('resuming processes', processId, o =>
      o.resumeProcessStream(processId)
    );
  }

  /**
   * {@link resumeProcessStream}, waiting for the transaction.
   *
   * @throws ProcessStatusError, with the registry error in `revertName`
   */
  async resumeProcess(processId: string): Promise<void> {
    await SmartContractService.executeTx(this.resumeProcessStream(processId));
  }

  /**
   * Moves the end of a READY or PAUSED process `seconds` later and returns
   * an async generator of transaction status events; completion carries the
   * new duration. Only before the current end: past it the tally may already
   * be public, so the registry refuses (`InvalidTimeBounds`).
   *
   * @param processId - The process ID
   * @param seconds - Seconds to add, a positive integer
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * await sdk.extendProcess(processId, 3600); // one more hour
   * ```
   */
  extendProcessStream(
    processId: string,
    seconds: number
  ): AsyncGenerator<TxStatusEvent<DurationChange>> {
    return this.organizerStream('changing the process duration', processId, o =>
      o.extendProcessStream(processId, seconds)
    );
  }

  /**
   * {@link extendProcessStream}, waiting for the transaction.
   *
   * @returns The new duration, in seconds from the start
   * @throws ProcessDurationError, with the registry error in `revertName`
   */
  async extendProcess(processId: string, seconds: number): Promise<DurationChange> {
    return SmartContractService.executeTx(this.extendProcessStream(processId, seconds));
  }

  /**
   * Closes a READY or PAUSED process `seconds` from now, with notice, and
   * returns an async generator of transaction status events. The new end is
   * the chain head's time plus `max(seconds, noticeMin)` plus `slack` for
   * the transaction's inclusion (the registry checks the notice when it
   * lands; default 45 s, a few seconds on a local chain). Nodes flush during
   * the notice and results follow the grace window: "voting closes in one
   * minute" at a meeting. Only before the current end, and only to an earlier
   * end; `endProcess` closes at once instead.
   *
   * @param processId - The process ID
   * @param seconds - Seconds from now; less than `noticeMin` means `noticeMin`
   * @param options - `slack` in seconds
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * const { noticeMin, graceFloor } = await sdk.getGraceParams();
   * await sdk.setProcessGrace(processId, graceFloor); // results soon after the close
   * await sdk.closeProcessIn(processId, noticeMin);
   * ```
   */
  closeProcessInStream(
    processId: string,
    seconds: number,
    options: CloseProcessOptions = {}
  ): AsyncGenerator<TxStatusEvent<DurationChange>> {
    return this.organizerStream('changing the process duration', processId, o =>
      o.closeProcessInStream(processId, seconds, options)
    );
  }

  /**
   * {@link closeProcessInStream}, waiting for the transaction.
   *
   * @returns The new duration, in seconds from the start
   * @throws ProcessDurationError, with the registry error in `revertName`
   */
  async closeProcessIn(
    processId: string,
    seconds: number,
    options: CloseProcessOptions = {}
  ): Promise<DurationChange> {
    return SmartContractService.executeTx(this.closeProcessInStream(processId, seconds, options));
  }

  /**
   * Sets the grace window of a READY or PAUSED process and returns an async
   * generator of transaction status events: the idle seconds after the last
   * landing that close the window and unlock the results. Only before the
   * end (`InvalidTimeBounds`), and within the registry's
   * `graceFloor..graceCeil` (`InvalidGrace`, see `getGraceParams`). A live
   * meeting sets the floor right after creation.
   *
   * @param processId - The process ID
   * @param grace - Seconds
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   */
  setProcessGraceStream(
    processId: string,
    grace: number
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('setting the grace window', processId, o =>
      o.setProcessGraceStream(processId, grace)
    );
  }

  /**
   * {@link setProcessGraceStream}, waiting for the transaction.
   *
   * @throws ProcessGraceError, with the registry error in `revertName`
   */
  async setProcessGrace(processId: string, grace: number): Promise<void> {
    await SmartContractService.executeTx(this.setProcessGraceStream(processId, grace));
  }

  /**
   * Sets the maximum number of voters of a READY or PAUSED process and
   * returns an async generator of transaction status events. Only before the
   * end (`InvalidTimeBounds`), never below the voters already counted
   * (`InvalidMaxVoters`), and within the result cap: `maxValue` at most
   * `1e12 / maxVoters` (`MaxPossibleResultCapExceeded`).
   *
   * @param processId - The process ID
   * @param maxVoters - The new maximum number of voters
   * @returns AsyncGenerator yielding transaction status events
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * for await (const event of sdk.setProcessMaxVotersStream(processId, 500)) {
   *   console.log(event.status);
   * }
   * ```
   */
  setProcessMaxVotersStream(
    processId: string,
    maxVoters: number
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('setting process maxVoters', processId, o =>
      o.setProcessMaxVotersStream(processId, maxVoters)
    );
  }

  /**
   * {@link setProcessMaxVotersStream}, waiting for the transaction.
   *
   * @throws ProcessMaxVotersError, with the registry error in `revertName`
   *
   * @example
   * ```typescript
   * await sdk.setProcessMaxVoters(processId, 500);
   * ```
   */
  async setProcessMaxVoters(processId: string, maxVoters: number): Promise<void> {
    await SmartContractService.executeTx(this.setProcessMaxVotersStream(processId, maxVoters));
  }

  /**
   * Publishes the organizer secret of a `'dkg-locked'` process and returns an
   * async generator of transaction status events; the committee then
   * decrypts the tally once the grace window has closed. It works at any
   * time and needs only the secret, not the organizer's account; revealing
   * while voting runs drops the process to the `'dkg'` trust model. A wrong
   * secret is refused by the simulation (`InvalidOrganizerSecret`) before
   * anything is sent.
   *
   * @param processId - The process ID
   * @param secret - `organizerSecret` from `createProcess`
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * const { processId, organizerSecret } = await sdk.createProcess({ ...config, keyMode: 'dkg-locked' });
   * // ... voting, the end, the grace window ...
   * await sdk.revealProcessKey(processId, organizerSecret!);
   * ```
   */
  revealProcessKeyStream(
    processId: string,
    secret: bigint
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('revealing the process key', processId, o =>
      o.revealProcessKeyStream(processId, secret)
    );
  }

  /**
   * {@link revealProcessKeyStream}, waiting for the transaction.
   *
   * @throws ProcessKeyRevealError, with the registry or DKG error in `revertName`
   */
  async revealProcessKey(processId: string, secret: bigint): Promise<void> {
    await SmartContractService.executeTx(this.revealProcessKeyStream(processId, secret));
  }

  /**
   * Moves an updatable census (origin 2) to a new version and returns an
   * async generator of transaction status events. An `OffchainDynamicCensus`
   * not yet published is uploaded first; a census file given by URL is
   * checked as nodes read it. The process is read before anything is
   * uploaded: a census of another origin fails with `CensusNotUpdatable`,
   * and the process must be READY or PAUSED, before its end, with the
   * signer as its organizer.
   *
   * Nodes load the new census in the background and answer votes 429 while
   * they do; a pending vote whose member was removed or reweighted fails
   * with `census changed, recast`.
   *
   * @param processId - The process ID
   * @param census - The new census, or `{ root, uri }` of a census file already served
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * census.add(['0x4444…']); // the OffchainDynamicCensus the process was created with
   * for await (const event of sdk.updateCensusStream(processId, census)) {
   *   console.log(event.status);
   * }
   * ```
   */
  updateCensusStream(
    processId: string,
    census: CensusUpdate
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('updating the census', processId, o =>
      o.updateCensusStream(processId, census)
    );
  }

  /**
   * {@link updateCensusStream}, waiting for the transaction.
   *
   * @example
   * ```typescript
   * census.remove('0x2222…');
   * await sdk.updateCensus(processId, census);
   * ```
   */
  async updateCensus(processId: string, census: CensusUpdate): Promise<void> {
    await SmartContractService.executeTx(this.updateCensusStream(processId, census));
  }

  /**
   * Moves a process to a new metadata document and returns an async
   * generator of transaction status events. A config or a document is
   * published through the uploader (bytes as given); a document already
   * served is given as `{ uri, hash? }`. The registry allows it while the
   * process is READY or PAUSED, before the end; readers see a new version.
   *
   * @param processId - The process ID
   * @param metadata - The new document, or where it is served
   *
   * @throws Error when the stream is first read, before any event: the SDK is
   *   not initialized, the process id is not the network's, or the signer has
   *   no provider or is on another chain. Refusals of the operation itself
   *   come as `Failed` events.
   *
   * @example
   * ```typescript
   * const stream = sdk.updateMetadataStream(processId, {
   *   title: 'Where should the new dog park go?',
   *   description: 'Corrected: the vote closes on Friday.',
   *   questions,
   * });
   * for await (const event of stream) console.log(event.status);
   * ```
   */
  updateMetadataStream(
    processId: string,
    metadata: MetadataUpdate
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    return this.organizerStream('updating the metadata', processId, o =>
      o.updateMetadataStream(processId, metadata)
    );
  }

  /**
   * {@link updateMetadataStream}, waiting for the transaction.
   *
   * @example
   * ```typescript
   * await sdk.updateMetadata(processId, { uri: 'https://files.example.org/metadata-2.json' });
   * ```
   */
  async updateMetadata(processId: string, metadata: MetadataUpdate): Promise<void> {
    await SmartContractService.executeTx(this.updateMetadataStream(processId, metadata));
  }

  /**
   * Cancels the organizer's processes that are still READY or PAUSED: by
   * default the ones this SDK instance created (a `WrongProcessIdError` one
   * included), else the `processIds` given, or with `all` every process the
   * signer created on the registry (one read per process). One transaction
   * each; it tries them all and reports what it canceled and what failed.
   *
   * @example
   * ```typescript
   * const { canceled, failed } = await sdk.cancelOpenProcesses();
   * ```
   */
  async cancelOpenProcesses(
    options: CancelOpenProcessesOptions = {}
  ): Promise<CancelOpenProcessesResult> {
    this.requireInit('canceling processes');
    for (const processId of options.processIds ?? []) this.checkProcessId(processId);
    const orchestrator = await this.organizer();
    return orchestrator.cancelOpenProcesses(options);
  }

  /**
   * The registry's grace window parameters, in seconds: `defaultGrace` (a new
   * process's), `graceFloor`..`graceCeil` (what `setProcessGrace` accepts),
   * `graceMaxTotal` (the window never closes later than the end plus this)
   * and `noticeMin` (the least notice `closeProcessIn` gives). Read once.
   */
  async getGraceParams(): Promise<GraceParams> {
    this.requireInit('reading the grace parameters');
    return this.readOrchestrator.getGraceParams();
  }

  /**
   * When a process's grace window closes: batches of votes cast before the
   * end land until then, and results unlock at it. Every landing after the
   * end pushes it out, up to the end plus `graceMaxTotal`. Null when the
   * registry holds no such process, or the window never closes (an end
   * within `graceMaxTotal` of 2^256).
   */
  async getGraceEnd(processId: string): Promise<Date | null> {
    this.requireInit('reading the grace window');
    this.checkProcessId(processId);
    return this.readOrchestrator.getGraceEnd(processId);
  }

  /**
   * The process ids the sequencer nodes know (the first node that answers).
   * A node serves one deployment: a `chainId` other than the network's is
   * refused.
   */
  async listProcesses(chainId?: number): Promise<string[]> {
    this.requireInit('listing processes');
    const network = this.network;
    if (chainId !== undefined && chainId !== network.chainId) {
      throw new Error(
        `This SDK works with ${network.name} (chain ${network.chainId}), not chain ${chainId}.`
      );
    }
    return this.api.nodes.firstAnswer(n => n.listProcesses());
  }

  /**
   * Checks the registry prefix of a process id (bytes 20..23) is the
   * network's, naming the known network it belongs to otherwise.
   */
  private checkProcessId(processId: string): void {
    const network = this.network;
    const prefix = processIdPrefixOf(processId);
    if (prefix === network.processIdPrefix) return;
    const other = networkOfProcessId(processId);
    throw new Error(
      other
        ? `Process ${processId} belongs to ${other.name} (chain ${other.chainId}); ` +
          `this SDK works with ${network.name} (chain ${network.chainId}).`
        : `Process ${processId} was not created by the ${network.name} registry ` +
          `(prefix ${prefix}, want ${network.processIdPrefix}).`
    );
  }

  /**
   * The organizer's orchestrator, once the signer is checked to be on the
   * network's chain (and the process to be the network's).
   */
  private async organizer(processId?: string): Promise<ProcessOrchestrationService> {
    const provider = this.ensureProvider();
    const network = this.network;
    if (processId !== undefined) this.checkProcessId(processId);
    const { chainId } = await provider.getNetwork();
    if (chainId !== BigInt(network.chainId)) {
      throw new Error(
        `The signer is on chain ${chainId}; the ${network.name} registry is on chain ${network.chainId}.`
      );
    }
    return this.processOrchestrator;
  }

  /**
   * The settings the SDK runs with, defaults applied: a snapshot, frozen all
   * the way down.
   */
  getConfig(): Readonly<DavinciSDKSettings> {
    return Object.freeze({ ...this.settings });
  }

  /** Whether `init()` has completed. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * The signer's provider.
   * @throws Error if the signer has no provider
   */
  private ensureProvider(): Provider {
    const provider = this.signer.provider;
    if (!provider) {
      throw new Error(
        'Provider required for blockchain operations (process management). ' +
          'The signer must be connected to a provider. ' +
          'Use wallet.connect(provider) or a browser signer like MetaMask. ' +
          'Note: Voting operations do not require a provider.'
      );
    }
    return provider;
  }
}
