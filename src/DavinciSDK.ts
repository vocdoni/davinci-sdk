import { getAddress, type Provider, type Signer } from 'ethers';
import { VocdoniApiService } from './core/api/ApiService';
import type { BaseServiceConfig } from './core/api/BaseService';
import type { DocumentOptions, Uploader } from './core/types/uploader';
import { ProcessRegistryService } from './contracts/ProcessRegistryService';
import { DeploymentPinError } from './contracts/errors';
import type { TxStatusEvent } from './contracts/SmartContractService';
import { BallotInputGenerator } from './sequencer/BallotInputGenerator';
import {
  ProcessOrchestrationService,
  ProcessConfig,
  ProcessCreationResult,
  ProcessInfo,
  type CensusUpdate,
  type MetadataUpdate,
} from './core/process';
import { VoteOrchestrationService, VoteConfig, VoteResult, VoteStatusInfo } from './core/vote';
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
  private ballotInputGenerator?: BallotInputGenerator;
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
   * Get or initialize the BallotInputGenerator service for ballot input generation
   */
  async getBallotInputGenerator(): Promise<BallotInputGenerator> {
    if (!this.ballotInputGenerator) {
      this.ballotInputGenerator = new BallotInputGenerator();
      await this.ballotInputGenerator.init();
    }

    return this.ballotInputGenerator;
  }

  /**
   * Get the process orchestration service for simplified process creation.
   * Requires `init()` and a signer with a provider for blockchain interactions.
   *
   * @throws Error if signer does not have a provider
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
   * Get the vote orchestration service for simplified voting; after `init()`.
   */
  get voteOrchestrator(): VoteOrchestrationService {
    this.requireInit('voting');
    this._voteOrchestrator ??= new VoteOrchestrationService(
      this.api,
      () => this.getBallotInputGenerator(),
      this.signer,
      this.censusProviders,
      { verifyProof: this.settings.verifyProof }
    );
    return this._voteOrchestrator;
  }

  /**
   * Gets user-friendly process information from the blockchain.
   * This method fetches raw contract data and transforms it into a user-friendly format
   * that matches the ProcessConfig interface used for creation, plus additional runtime data.
   *
   * The metadata document is downloaded and checked against the registry's
   * `metadataHash`: title, description and questions come from it only when
   * it matches (`metadataVerified`, `metadataStatus`).
   *
   * Reads through the SDK's read provider: a voter's bare wallet is enough.
   *
   * @param processId - The process ID to fetch; it must be one of the network's registry
   * @returns Promise resolving to user-friendly process information
   * @throws Error for a process id of another registry
   *
   * @example
   * ```typescript
   * const processInfo = await sdk.getProcess("0x1234567890abcdef...");
   *
   * // Access the same fields as ProcessConfig
   * console.log("Title:", processInfo.title);
   * console.log("Description:", processInfo.description);
   * console.log("Questions:", processInfo.questions);
   * console.log("Metadata verified:", processInfo.metadataVerified);
   * console.log("Ballot config:", processInfo.ballot);
   *
   * // Plus additional runtime information
   * console.log("Status:", processInfo.status);
   * console.log("Creator:", processInfo.creator);
   * console.log("Start date:", processInfo.startDate);
   * console.log("End date:", processInfo.endDate);
   * console.log("Duration:", processInfo.duration, "seconds");
   * console.log("Time remaining:", processInfo.timeRemaining, "seconds");
   *
   * // Access raw contract data if needed
   * console.log("Raw data:", processInfo.raw);
   * ```
   */
  async getProcess(processId: string): Promise<ProcessInfo> {
    this.requireInit('getting processes');
    this.checkProcessId(processId);
    return this.readOrchestrator.getProcess(processId);
  }

  /**
   * Creates a complete voting process and returns an async generator that yields transaction status events.
   * This method allows you to monitor the transaction progress in real-time, including pending, completed,
   * failed, and reverted states.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param config - Simplified process configuration
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.createProcessStream({
   *   title: "My Election",
   *   description: "A simple election",
   *   census: {
   *     type: CensusOrigin.OffchainStatic,
   *     root: "0x1234...",
   *     uri: "https://files.example.org/census.json"
   *   },
   *   maxVoters: 100,
   *   ballot: {
   *     numFields: 2,
   *     maxValue: "3",
   *     minValue: "0",
   *     uniqueValues: false,
   *     costExponent: 10000,
   *     maxValueSum: "6",
   *     minValueSum: "0"
   *   },
   *   timing: {
   *     startDate: new Date("2024-12-01T10:00:00Z"),
   *     duration: 3600 * 24
   *   },
   *   questions: [
   *     {
   *       title: "What is your favorite color?",
   *       choices: [
   *         { title: "Red", value: 0 },
   *         { title: "Blue", value: 1 }
   *       ]
   *     }
   *   ]
   * });
   *
   * // Monitor transaction progress
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       // Update UI to show pending state
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process created:", event.response.processId);
   *       console.log("Transaction hash:", event.response.transactionHash);
   *       // Update UI to show success
   *       break;
   *     case TxStatus.Failed:
   *       console.error("Transaction failed:", event.error);
   *       // Update UI to show error
   *       break;
   *     case TxStatus.Reverted:
   *       console.error("Transaction reverted:", event.reason);
   *       // Update UI to show revert reason
   *       break;
   *   }
   * }
   * ```
   */
  createProcessStream(config: ProcessConfig) {
    return this.createProcessStreamInternal(config);
  }

  private async *createProcessStreamInternal(
    config: ProcessConfig
  ): AsyncGenerator<TxStatusEvent<ProcessCreationResult>> {
    this.requireInit('creating processes');
    const processOrchestrator = await this.organizer();
    yield* processOrchestrator.createProcessStream(config);
  }

  /**
   * Creates a complete voting process with minimal configuration.
   * This is the ultra-easy method for end users that handles all the complex orchestration internally.
   *
   * For real-time transaction status updates, use createProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * The method automatically:
   * - Publishes a Merkle census object and the metadata document through
   *   the configured `uploader`, checking each URL as nodes and readers will
   * - Gets the encryption key from the key sequencer for the next process id
   * - Submits the on-chain transaction
   *
   * @param config - Simplified process configuration
   * @returns Promise resolving to the process creation result
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * // Option 1: a census object and the metadata fields (needs an uploader)
   * const census = new OffchainCensus();
   * census.add(['0x1111…', '0x2222…']);
   * const result1 = await sdk.createProcess({
   *   title: "My Election",
   *   description: "A simple election",
   *   census,
   *   ballot: {
   *     numFields: 2,
   *     maxValue: "3",
   *     minValue: "0",
   *     uniqueValues: false,
   *     costExponent: 10000,
   *     maxValueSum: "6",
   *     minValueSum: "0"
   *   },
   *   timing: {
   *     startDate: new Date("2024-12-01T10:00:00Z"),
   *     duration: 3600 * 24
   *   },
   *   questions: [
   *     {
   *       title: "What is your favorite color?",
   *       choices: [
   *         { title: "Red", value: 0 },
   *         { title: "Blue", value: 1 }
   *       ]
   *     }
   *   ]
   * });
   *
   * // Option 2: Using start and end dates
   * const result2 = await sdk.createProcess({
   *   title: "Weekend Vote",
   *   timing: {
   *     startDate: "2024-12-07T09:00:00Z",
   *     endDate: "2024-12-08T18:00:00Z"
   *   }
   * });
   * ```
   */
  async createProcess(config: ProcessConfig): Promise<ProcessCreationResult> {
    this.requireInit('creating processes');
    const processOrchestrator = await this.organizer();
    return processOrchestrator.createProcess(config);
  }

  /**
   * Submit a vote with simplified configuration.
   * This is the ultra-easy method for end users that handles all the complex voting workflow internally.
   *
   * Does NOT require a provider - can be used with a bare Wallet for signing only.
   *
   * The method automatically:
   * - Fetches process information and validates voting is allowed
   * - Gets census proof (Merkle tree based)
   * - Generates cryptographic proofs and encrypts the vote
   * - Signs and submits the vote to the sequencer
   *
   * @param config - Simplified vote configuration
   * @returns Promise resolving to vote submission result
   *
   * @example
   * ```typescript
   * // Submit a vote with voter's private key
   * const voteResult = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [1, 0], // Vote for option 1 in question 1, option 0 in question 2
   *   voterKey: "0x1234567890abcdef..." // Voter's private key
   * });
   *
   * console.log("Vote ID:", voteResult.voteId);
   * console.log("Status:", voteResult.status);
   *
   * // Submit a vote with a Wallet instance
   * import { Wallet } from "ethers";
   * const voterWallet = new Wallet("0x...");
   *
   * const voteResult2 = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [2], // Single question vote
   *   voterKey: voterWallet
   * });
   * ```
   */
  async submitVote(config: VoteConfig): Promise<VoteResult> {
    this.requireInit('submitting votes');

    return this.voteOrchestrator.submitVote(config);
  }

  /**
   * Get the status of a submitted vote.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID returned from submitVote()
   * @returns Promise resolving to vote status information
   *
   * @example
   * ```typescript
   * const statusInfo = await sdk.getVoteStatus(processId, voteId);
   * console.log("Vote status:", statusInfo.status);
   * // Possible statuses: "pending", "aggregated", "processed", "settled", "error"
   * ```
   */
  async getVoteStatus(processId: string, voteId: string): Promise<VoteStatusInfo> {
    this.requireInit('getting vote status');

    return this.voteOrchestrator.getVoteStatus(processId, voteId);
  }

  /**
   * Check if an address has voted in a process.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param address - The voter's address
   * @returns Promise resolving to boolean indicating if the address has voted
   *
   * @example
   * ```typescript
   * const hasVoted = await sdk.hasAddressVoted(processId, "0x1234567890abcdef...");
   * if (hasVoted) {
   *   console.log("This address has already voted");
   * }
   * ```
   */
  async hasAddressVoted(processId: string, address: string): Promise<boolean> {
    this.requireInit('checking vote status');

    return this.voteOrchestrator.hasAddressVoted(processId, address);
  }

  /**
   * Check if an address is able to vote in a process (i.e., is in the census).
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param address - The voter's address
   * @returns Promise resolving to boolean indicating if the address can vote
   *
   * @example
   * ```typescript
   * const canVote = await sdk.isAddressAbleToVote(processId, "0x1234567890abcdef...");
   * if (canVote) {
   *   console.log("This address can vote");
   * } else {
   *   console.log("This address is not in the census");
   * }
   * ```
   */
  async isAddressAbleToVote(processId: string, address: string): Promise<boolean> {
    this.requireInit('checking if address can vote');

    return this.api.nodes.firstAnswer(n => n.isAddressAbleToVote(processId, address));
  }

  /**
   * Get the voting weight for an address in a process.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param address - The voter's address
   * @returns Promise resolving to the address weight as a string
   *
   * @example
   * ```typescript
   * const weight = await sdk.getAddressWeight(processId, "0x1234567890abcdef...");
   * console.log("Address weight:", weight);
   * ```
   */
  async getAddressWeight(processId: string, address: string): Promise<string> {
    this.requireInit('getting address weight');

    const weight = await this.api.nodes.firstAnswer(n => n.getAddressWeight(processId, address));
    return weight.toString();
  }

  /**
   * Watch vote status changes in real-time using an async generator.
   * This method yields each status change as it happens, perfect for showing
   * progress indicators in UI applications.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @param options - Optional configuration
   * @returns AsyncGenerator yielding vote status updates
   *
   * @example
   * ```typescript
   * // Submit vote
   * const voteResult = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [1]
   * });
   *
   * // Watch status changes in real-time
   * for await (const statusInfo of sdk.watchVoteStatus(voteResult.processId, voteResult.voteId)) {
   *   console.log(`Vote status: ${statusInfo.status}`);
   *
   *   switch (statusInfo.status) {
   *     case VoteStatus.Pending:
   *       console.log("⏳ Processing...");
   *       break;
   *     case VoteStatus.Aggregated:
   *       console.log("📊 Vote aggregated");
   *       break;
   *     case VoteStatus.Settled:
   *       console.log("✅ Vote settled");
   *       break;
   *   }
   * }
   * ```
   */
  watchVoteStatus(
    processId: string,
    voteId: string,
    options?: {
      targetStatus?: VoteStatus;
      timeoutMs?: number;
      pollIntervalMs?: number;
    }
  ) {
    this.requireInit('watching vote status');

    return this.voteOrchestrator.watchVoteStatus(processId, voteId, options);
  }

  /**
   * Wait for a vote to reach a specific status.
   * This is a simpler alternative to watchVoteStatus() that returns only the final status.
   * Useful for waiting for vote confirmation and processing without needing to handle each intermediate status.
   *
   * Does NOT require a provider - uses API calls only.
   *
   * @param processId - The process ID
   * @param voteId - The vote ID
   * @param targetStatus - The target status to wait for (default: "settled")
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 300000 = 5 minutes)
   * @param pollIntervalMs - Polling interval in milliseconds (default: 5000 = 5 seconds)
   * @returns Promise resolving to final vote status
   *
   * @example
   * ```typescript
   * // Submit vote and wait for it to be settled
   * const voteResult = await sdk.submitVote({
   *   processId: "0x1234567890abcdef...",
   *   choices: [1]
   * });
   *
   * // Wait for the vote to be fully processed
   * const finalStatus = await sdk.waitForVoteStatus(
   *   voteResult.processId,
   *   voteResult.voteId,
   *   VoteStatus.Settled, // Wait until vote is settled
   *   300000,    // 5 minute timeout
   *   5000       // Check every 5 seconds
   * );
   *
   * console.log("Vote final status:", finalStatus.status);
   * ```
   */
  async waitForVoteStatus(
    processId: string,
    voteId: string,
    targetStatus: VoteStatus = VoteStatus.Settled,
    timeoutMs: number = 300000,
    pollIntervalMs: number = 5000
  ): Promise<VoteStatusInfo> {
    this.requireInit('waiting for vote status');

    return this.voteOrchestrator.waitForVoteStatus(
      processId,
      voteId,
      targetStatus,
      timeoutMs,
      pollIntervalMs
    );
  }

  /**
   * Ends a voting process by setting its status to ENDED and returns an async generator
   * that yields transaction status events. This method allows you to monitor the
   * transaction progress in real-time.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to end
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.endProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
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
  endProcessStream(processId: string) {
    return this.endProcessStreamInternal(processId);
  }

  private async *endProcessStreamInternal(
    processId: string
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    this.requireInit('ending processes');
    const processOrchestrator = await this.organizer(processId);
    yield* processOrchestrator.endProcessStream(processId);
  }

  /**
   * Ends a voting process by setting its status to ENDED.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use endProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to end
   * @returns Promise resolving when the process is ended
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.endProcess("0x1234567890abcdef...");
   * console.log("Process ended successfully");
   * ```
   */
  async endProcess(processId: string): Promise<void> {
    this.requireInit('ending processes');
    const processOrchestrator = await this.organizer(processId);
    return processOrchestrator.endProcess(processId);
  }

  /**
   * Pauses a voting process by setting its status to PAUSED and returns an async generator
   * that yields transaction status events. This method allows you to monitor the
   * transaction progress in real-time.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to pause
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.pauseProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process paused successfully");
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
  pauseProcessStream(processId: string) {
    return this.pauseProcessStreamInternal(processId);
  }

  private async *pauseProcessStreamInternal(
    processId: string
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    this.requireInit('pausing processes');
    const processOrchestrator = await this.organizer(processId);
    yield* processOrchestrator.pauseProcessStream(processId);
  }

  /**
   * Pauses a voting process by setting its status to PAUSED.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use pauseProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to pause
   * @returns Promise resolving when the process is paused
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.pauseProcess("0x1234567890abcdef...");
   * console.log("Process paused successfully");
   * ```
   */
  async pauseProcess(processId: string): Promise<void> {
    this.requireInit('pausing processes');
    const processOrchestrator = await this.organizer(processId);
    return processOrchestrator.pauseProcess(processId);
  }

  /**
   * Cancels a voting process by setting its status to CANCELED and returns an async generator
   * that yields transaction status events. This method allows you to monitor the
   * transaction progress in real-time.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to cancel
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.cancelProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process canceled successfully");
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
  cancelProcessStream(processId: string) {
    return this.cancelProcessStreamInternal(processId);
  }

  private async *cancelProcessStreamInternal(
    processId: string
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    this.requireInit('canceling processes');
    const processOrchestrator = await this.organizer(processId);
    yield* processOrchestrator.cancelProcessStream(processId);
  }

  /**
   * Cancels a voting process by setting its status to CANCELED.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use cancelProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to cancel
   * @returns Promise resolving when the process is canceled
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.cancelProcess("0x1234567890abcdef...");
   * console.log("Process canceled successfully");
   * ```
   */
  async cancelProcess(processId: string): Promise<void> {
    this.requireInit('canceling processes');
    const processOrchestrator = await this.organizer(processId);
    return processOrchestrator.cancelProcess(processId);
  }

  /**
   * Resumes a voting process by setting its status to READY and returns an async generator
   * that yields transaction status events. This is typically used to resume a paused process.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to resume
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.resumeProcessStream("0x1234567890abcdef...");
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("Process resumed successfully");
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
  resumeProcessStream(processId: string) {
    return this.resumeProcessStreamInternal(processId);
  }

  private async *resumeProcessStreamInternal(
    processId: string
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    this.requireInit('resuming processes');
    const processOrchestrator = await this.organizer(processId);
    yield* processOrchestrator.resumeProcessStream(processId);
  }

  /**
   * Resumes a voting process by setting its status to READY.
   * This is typically used to resume a paused process.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use resumeProcessStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID to resume
   * @returns Promise resolving when the process is resumed
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.resumeProcess("0x1234567890abcdef...");
   * console.log("Process resumed successfully");
   * ```
   */
  async resumeProcess(processId: string): Promise<void> {
    this.requireInit('resuming processes');
    const processOrchestrator = await this.organizer(processId);
    return processOrchestrator.resumeProcess(processId);
  }

  /**
   * Sets the maximum number of voters for a process and returns an async generator
   * that yields transaction status events. This allows you to change the voter limit
   * after process creation.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID
   * @param maxVoters - The new maximum number of voters
   * @returns AsyncGenerator yielding transaction status events
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * const stream = sdk.setProcessMaxVotersStream("0x1234567890abcdef...", 500);
   *
   * for await (const event of stream) {
   *   switch (event.status) {
   *     case TxStatus.Pending:
   *       console.log("Transaction pending:", event.hash);
   *       break;
   *     case TxStatus.Completed:
   *       console.log("MaxVoters updated successfully");
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
  setProcessMaxVotersStream(processId: string, maxVoters: number) {
    return this.setProcessMaxVotersStreamInternal(processId, maxVoters);
  }

  private async *setProcessMaxVotersStreamInternal(
    processId: string,
    maxVoters: number
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    this.requireInit('setting process maxVoters');
    const processOrchestrator = await this.organizer(processId);
    yield* processOrchestrator.setProcessMaxVotersStream(processId, maxVoters);
  }

  /**
   * Sets the maximum number of voters for a process.
   * This is the simplified method that waits for transaction completion.
   *
   * For real-time transaction status updates, use setProcessMaxVotersStream() instead.
   *
   * Requires a signer with a provider for blockchain interactions.
   *
   * @param processId - The process ID
   * @param maxVoters - The new maximum number of voters
   * @returns Promise resolving when the maxVoters is updated
   * @throws Error if signer does not have a provider
   *
   * @example
   * ```typescript
   * await sdk.setProcessMaxVoters("0x1234567890abcdef...", 500);
   * console.log("MaxVoters updated successfully");
   * ```
   */
  async setProcessMaxVoters(processId: string, maxVoters: number): Promise<void> {
    this.requireInit('setting process maxVoters');
    const processOrchestrator = await this.organizer(processId);
    return processOrchestrator.setProcessMaxVoters(processId, maxVoters);
  }

  /**
   * Moves an updatable census (origin 2) to a new version and returns an
   * async generator of transaction status events. An `OffchainDynamicCensus`
   * not yet published is uploaded first; a census file given by URL is
   * checked as nodes read it. The process is read before anything is
   * uploaded: a census of another origin fails with `CensusNotUpdatable`,
   * and the process must be READY or PAUSED and the signer its organizer.
   *
   * Nodes load the new census in the background and answer votes 429 while
   * they do; a pending vote whose member was removed or reweighted fails
   * with `census changed, recast`.
   *
   * @param processId - The process ID
   * @param census - The new census, or `{ root, uri }` of a census file already served
   *
   * @example
   * ```typescript
   * census.add(['0x4444…']); // the OffchainDynamicCensus the process was created with
   * for await (const event of sdk.updateCensusStream(processId, census)) {
   *   console.log(event.status);
   * }
   * ```
   */
  updateCensusStream(processId: string, census: CensusUpdate) {
    return this.updateCensusStreamInternal(processId, census);
  }

  private async *updateCensusStreamInternal(
    processId: string,
    census: CensusUpdate
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    this.requireInit('updating the census');
    const processOrchestrator = await this.organizer(processId);
    yield* processOrchestrator.updateCensusStream(processId, census);
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
    this.requireInit('updating the census');
    const processOrchestrator = await this.organizer(processId);
    return processOrchestrator.updateCensus(processId, census);
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
  updateMetadataStream(processId: string, metadata: MetadataUpdate) {
    return this.updateMetadataStreamInternal(processId, metadata);
  }

  private async *updateMetadataStreamInternal(
    processId: string,
    metadata: MetadataUpdate
  ): AsyncGenerator<TxStatusEvent<{ success: boolean }>> {
    this.requireInit('updating the metadata');
    const processOrchestrator = await this.organizer(processId);
    yield* processOrchestrator.updateMetadataStream(processId, metadata);
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
    this.requireInit('updating the metadata');
    const processOrchestrator = await this.organizer(processId);
    return processOrchestrator.updateMetadata(processId, metadata);
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

  /**
   * Check if the SDK has been initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * The signer's provider.
   * @throws Error if the signer does not have a provider
   * @private
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
