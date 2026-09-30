import {
  FetchRequest,
  Wallet,
  ZeroAddress,
  keccak256,
  toUtf8Bytes,
  toUtf8String,
  type JsonRpcPayload,
} from 'ethers';
import { DavinciSDK, type DavinciSDKConfig } from '../../../src/DavinciSDK';
import {
  DAVINCI_DKG_ADAPTER_ABI,
  DeploymentPinError,
  PROCESS_REGISTRY_ABI,
  ZISK_VERIFIER_ABI,
} from '../../../src/contracts';
import { bjjMulBase } from '../../../src/crypto';
import { FailoverRpcProvider, GNOSIS, processIdPrefix } from '../../../src/networks';
import { RELEASE_PINS } from '../../../src/protocol';
import { ArtifactError, BALLOT_ARTIFACTS } from '../../../src/prover';
import {
  NodeMismatchError,
  SequencerError,
  SequencerUnavailableError,
  type SequencerInfo,
} from '../../../src/sequencer';
import { MockChain, type CallHandler } from '../../helpers/mockChain';

const KEY = `0x${'11'.repeat(32)}`;
const VERIFIER = '0x150547716bD6f15D872508b66b2ae7ce17677C9C';
const ADAPTER = '0xE9559c78E7ff8c19937A0657a092A221E90CCBC3';
const LOCAL_REGISTRY = '0x015eAc820688DA203a0bd730a8a7A4CDB97E1a02';
const CODE = '0x6001600101';
// The mock verifier's code is not the release's: pin its hash.
const VERIFY = { pins: { ziskVerifierCodeHash: keccak256(CODE) } };
const A = 'https://a.sequencer.test';
const B = 'https://b.sequencer.test';
const C = 'https://c.sequencer.test';

// 20-byte creator + 4-byte registry prefix + 7-byte nonce.
const pidWith = (prefix: string) => `0x${'aa'.repeat(20)}${prefix.slice(2)}${'00'.repeat(6)}01`;
const PID = pidWith('0xf5848002');
const KEY_POINT = bjjMulBase(12345n);

function onchainProcess(): Record<string, unknown> {
  return {
    status: 0,
    organizationId: `0x${'aa'.repeat(20)}`,
    encryptionKey: { x: KEY_POINT.x, y: KEY_POINT.y },
    latestStateRoot: `0x${'04'.repeat(32)}`,
    result: [],
    startTime: 1_700_000_000n,
    duration: 3600n,
    maxVoters: 100n,
    votersCount: 0n,
    overwrittenVotesCount: 0n,
    creationBlock: 48_600_000n,
    batchNumber: 0n,
    metadataURI: '',
    metadataHash: `0x${'aa'.repeat(32)}`,
    ballotMode: {
      uniqueValues: false,
      numFields: 2,
      groupSize: 1,
      costExponent: 1,
      maxValue: 5n,
      minValue: 0n,
      maxValueSum: 10n,
      minValueSum: 0n,
    },
    census: {
      censusOrigin: 1,
      censusRoot: `0x${'00'.repeat(31)}05`,
      contractAddress: ZeroAddress,
      censusURI: 'https://census.example/c.json',
      onchainAllowAnyValidRoot: false,
    },
    keyMode: 0,
    dkgEpochId: `0x${'00'.repeat(12)}`,
    dkgFirstIndex: 0,
    dkgCount: 0,
    dkgZeroSkipped: 0,
    dkgResultsRequested: false,
    dkgAid: `0x${'00'.repeat(32)}`,
    grace: 180,
    lastVoteAt: 0n,
  };
}

// A registry that pins this release on `chain`, with its verifier and DKG adapter.
function deploy(
  chain: MockChain,
  registry = GNOSIS.processRegistry,
  calls: Record<string, CallHandler> = {}
): MockChain {
  chain.contract(registry, PROCESS_REGISTRY_ABI, {
    chainID: () => [chain.chainId],
    batchProgramVK: () => [RELEASE_PINS.batchProgramVK],
    resultsProgramVK: () => [RELEASE_PINS.resultsProgramVK],
    rootCVadcopFinal: () => [RELEASE_PINS.rootCVadcopFinal],
    ballotVKHash: () => [RELEASE_PINS.ballotVKHash],
    ziskVerifier: () => [VERIFIER],
    dkgAdapter: () => [ADAPTER],
    getProcess: () => [onchainProcess()],
    ...calls,
  });
  chain.contract(ADAPTER, DAVINCI_DKG_ADAPTER_ABI, { registry: () => [registry] });
  chain.contract(VERIFIER, ZISK_VERIFIER_ABI, {
    getRootCVadcopFinal: () => [RELEASE_PINS.rootCVadcopFinal],
  });
  chain.setCode(VERIFIER, CODE);
  return chain;
}

type NodeSpec = Partial<SequencerInfo> | 'down' | number | 'garbage';

// Sequencer nodes by origin; a node of the Gnosis deployment unless told otherwise.
function nodes(specs: Record<string, NodeSpec>) {
  const seen: string[] = [];
  const fetchImpl = vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    seen.push(`${url.origin}${url.pathname}`);
    const spec = specs[url.origin] ?? 'down';
    if (spec === 'down') return Promise.reject(new TypeError('fetch failed'));
    if (spec === 'garbage') return Promise.resolve(new Response('<html>', { status: 200 }));
    if (typeof spec === 'number') {
      const body = JSON.stringify({ error: 'nope', code: spec * 100 + 1 });
      return Promise.resolve(new Response(body, { status: spec }));
    }
    const body =
      url.pathname === '/info'
        ? {
            sequencerAddress: '0x70debac0bf6fcc5f99646fcbcffb6d8267184dec',
            chainId: 100,
            processRegistry: GNOSIS.processRegistry,
            ballotVkHash: RELEASE_PINS.ballotVKHash,
            batchProgramVk: RELEASE_PINS.batchProgramVK,
            resultsProgramVk: RELEASE_PINS.resultsProgramVK,
            observer: false,
            settledBySelf: 0,
            syncedFromOthers: 0,
            lostRaces: 0,
            ...spec,
          }
        : { processes: [PID] };
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    );
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

// Routes ethers' HTTP JSON-RPC by host to mock chains; records the hosts asked.
function rpcRoutes(chains: Record<string, MockChain>) {
  const seen: { host: string; userAgent?: string }[] = [];
  FetchRequest.registerGetUrl(async req => {
    const host = new URL(req.url).host;
    seen.push({ host, userAgent: req.headers['user-agent'] });
    const chain = chains[host];
    if (!chain) throw new Error(`no route to ${host}`);
    const payload = JSON.parse(toUtf8String(req.body ?? new Uint8Array())) as
      | JsonRpcPayload
      | JsonRpcPayload[];
    const answers = await chain._send(payload);
    return {
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'application/json' },
      body: toUtf8Bytes(JSON.stringify(Array.isArray(payload) ? answers : answers[0])),
    };
  });
  return seen;
}

function sdkWith(
  config: Partial<DavinciSDKConfig>,
  specs: Record<string, NodeSpec> = { [A]: {}, [B]: {} }
) {
  const node = nodes(specs);
  const sdk = new DavinciSDK({
    signer: new Wallet(KEY, deploy(new MockChain())),
    sequencerUrls: [A, B],
    verifyDeployment: VERIFY,
    sequencerConfig: { fetchImpl: node.fetchImpl },
    ...config,
  });
  return { sdk, node };
}

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

afterEach(() => {
  FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc());
});

describe('DavinciSDK configuration', () => {
  it('defaults to Gnosis and takes the deprecated single node URL too', () => {
    const sdk = new DavinciSDK({
      signer: Wallet.createRandom(),
      sequencerUrls: [A, B],
      sequencerUrl: A,
    });
    const settings = sdk.getConfig();
    expect(settings.network?.name).toBe('gnosis');
    expect(settings.network?.processIdPrefix).toBe('0xf5848002');
    expect(settings.sequencerUrls).toEqual([A, B]);
    expect(settings.verifyDeployment).toBe(true);
    expect(settings.verifyProof).toBe(true);
    expect(new DavinciSDK({ signer: Wallet.createRandom(), sequencerUrl: C }).getConfig()).toEqual(
      expect.objectContaining({ sequencerUrls: [C] })
    );
  });

  it('refuses an unknown network, no node, or a registry that is not the network one', () => {
    const signer = Wallet.createRandom();
    expect(() => new DavinciSDK({ signer, network: 'mainnet', sequencerUrls: [A] })).toThrow(
      'unknown network "mainnet"'
    );
    expect(() => new DavinciSDK({ signer })).toThrow('sequencerUrls is required');
    expect(
      () =>
        new DavinciSDK({
          signer,
          network: 'gnosis',
          sequencerUrls: [A],
          addresses: { processRegistry: LOCAL_REGISTRY },
        })
    ).toThrow(`addresses.processRegistry ${LOCAL_REGISTRY} is not the gnosis registry`);
    expect(
      () =>
        new DavinciSDK({
          signer,
          network: 'gnosis',
          sequencerUrls: [A],
          addresses: { processRegistry: GNOSIS.processRegistry.toLowerCase() },
        })
    ).not.toThrow();
  });

  it('needs init() before the node clients, the registry, the network and any write', () => {
    const { sdk } = sdkWith({});
    const guarded: [() => unknown, string][] = [
      [() => sdk.api, 'using the sequencer API'],
      [() => sdk.registry, 'reading the registry'],
      [() => sdk.network, 'reading the network'],
      [() => sdk.provider, 'reading the chain'],
      [() => sdk.processes, 'using the process registry'],
      [() => sdk.processOrchestrator, 'creating or managing processes'],
      [() => sdk.voteOrchestrator, 'voting'],
    ];
    for (const [get, what] of guarded) {
      expect(get).toThrow(`SDK must be initialized before ${what}. Call sdk.init() first.`);
    }
    expect(sdk.isInitialized()).toBe(false);
  });

  it('hands out a frozen snapshot of the settings, apart from the config given', () => {
    const urls = [A, B];
    const rpcUrls = ['https://rpc.test'];
    const pins = { ziskVerifierCodeHash: `0x${'01'.repeat(32)}` };
    const sdk = new DavinciSDK({
      signer: Wallet.createRandom(),
      sequencerUrls: urls,
      rpcUrls,
      verifyDeployment: { pins },
    });
    urls.push(C);
    rpcUrls.push('https://other.test');
    pins.ziskVerifierCodeHash = `0x${'02'.repeat(32)}`;
    const settings = sdk.getConfig();
    expect(settings.sequencerUrls).toEqual([A, B]);
    expect(settings.rpcUrls).toEqual(['https://rpc.test']);
    expect(settings.verifyDeployment).toEqual({
      pins: { ziskVerifierCodeHash: `0x${'01'.repeat(32)}` },
    });

    expect(Object.isFrozen(settings)).toBe(true);
    expect(() => (settings.sequencerUrls as string[]).push(C)).toThrow(TypeError);
    expect(() => {
      (settings.network as { chainId: number }).chainId = 1;
    }).toThrow(TypeError);
    expect(() => (settings.network?.rpcUrls as string[]).push('x')).toThrow(TypeError);
    expect(() => {
      (settings.verifyDeployment as { pins: Record<string, string> }).pins.ballotVKHash = 'x';
    }).toThrow(TypeError);
    expect(sdk.getConfig().sequencerUrls).toEqual([A, B]);
    expect(sdk.getConfig().network?.chainId).toBe(100);
  });

  it('checks the artifacts table when the config is read', () => {
    const signer = Wallet.createRandom();
    const entry = BALLOT_ARTIFACTS[RELEASE_PINS.ballotVKHash];
    expect(
      () =>
        new DavinciSDK({ signer, sequencerUrls: [A], artifacts: { table: { '0x1234': entry } } })
    ).toThrow(new ArtifactError('artifacts table key "0x1234" is not a 32-byte ballot VK hash'));
    expect(
      () => new DavinciSDK({ signer, sequencerUrls: [A], artifacts: { timeoutMs: 0 } })
    ).toThrow(ArtifactError);
  });
});

describe('DavinciSDK.init', () => {
  it('connects to the network, checks the pins and every node', async () => {
    const chain = deploy(new MockChain());
    const node = nodes({ [A]: {}, [B]: {} });
    const sdk = new DavinciSDK({
      signer: new Wallet(KEY, chain),
      sequencerUrls: [A, B],
      verifyDeployment: VERIFY,
      sequencerConfig: { fetchImpl: node.fetchImpl },
    });
    await Promise.all([sdk.init(), sdk.init()]);
    await sdk.init();
    expect(sdk.isInitialized()).toBe(true);
    expect(sdk.network.name).toBe('gnosis');
    expect(sdk.registry.address).toBe(GNOSIS.processRegistry);
    expect(sdk.api.nodes.urls).toEqual([A, B]);
    expect(sdk.api.sequencer.getBaseUrl()).toBe(A);
    expect(sdk.nodeChecks.map(c => [c.url, c.status, c.reason])).toEqual([
      [A, 'usable', undefined],
      [B, 'usable', undefined],
    ]);
    // One /info per node, whatever the number of init() calls; the pins were checked.
    expect(node.seen).toEqual([`${A}/info`, `${B}/info`]);
    expect(chain.calls('eth_getCode')).toHaveLength(1);
    // The organizer's provider is on the network's chain: reads go through it.
    expect(sdk.provider).toBe(chain);
  });

  it('checks the deployment against this release by default, and skips it when told', async () => {
    const pinned = sdkWith({ verifyDeployment: undefined });
    const err = await errorOf(pinned.sdk.init());
    expect(err).toBeInstanceOf(DeploymentPinError);
    expect(err).toMatchObject({ field: 'verifier code hash' });

    const chain = deploy(new MockChain());
    const skipped = sdkWith({ signer: new Wallet(KEY, chain), verifyDeployment: false });
    await skipped.sdk.init();
    expect(chain.calls('eth_getCode')).toHaveLength(0);
  });

  it("refuses a registry that is not on the network's chain, or not there at all", async () => {
    const wrongChain = deploy(new MockChain(), GNOSIS.processRegistry, {
      chainID: () => [10200],
    });
    const err = await errorOf(
      sdkWith({ signer: new Wallet(KEY, wrongChain), verifyDeployment: false }).sdk.init()
    );
    expect(err).toBeInstanceOf(DeploymentPinError);
    expect(err).toMatchObject({ field: 'chainID', expected: '100', got: '10200' });

    const empty = sdkWith({ signer: new Wallet(KEY, new MockChain()) });
    await expect(empty.sdk.init()).rejects.toThrow(
      `cannot read the gnosis ProcessRegistry at ${GNOSIS.processRegistry} (is the read RPC on chain 100?)`
    );
  });

  it('fails on a node of another deployment or release', async () => {
    const other = `0x${'99'.repeat(32)}`;
    const cases: [string, Partial<SequencerInfo>][] = [
      ['chainId', { chainId: 10200 }],
      ['processRegistry', { processRegistry: LOCAL_REGISTRY }],
      ['ballotVkHash', { ballotVkHash: other }],
      ['batchProgramVk', { batchProgramVk: other }],
      ['resultsProgramVk', { resultsProgramVk: other }],
    ];
    for (const [field, info] of cases) {
      const { sdk } = sdkWith({}, { [A]: {}, [B]: info });
      const err = await errorOf(sdk.init());
      expect(err, field).toBeInstanceOf(NodeMismatchError);
      expect(err).toMatchObject({ field, node: B });
      expect(sdk.isInitialized()).toBe(false);
    }
  });

  it('compares the nodes with the registry, not with this release', async () => {
    const other = `0x${'99'.repeat(32)}`;
    const chain = deploy(new MockChain(), GNOSIS.processRegistry, {
      ballotVKHash: () => [other],
    });
    const { sdk } = sdkWith(
      { signer: new Wallet(KEY, chain), verifyDeployment: false },
      { [A]: { ballotVkHash: other }, [B]: { ballotVkHash: other } }
    );
    await sdk.init();
    expect(sdk.api.nodes.urls).toEqual([A, B]);
  });

  it('leaves out observers and nodes that are down', async () => {
    const { sdk } = sdkWith(
      { sequencerUrls: [A, B, C] },
      { [A]: 'down', [B]: { observer: true, sequencerAddress: null }, [C]: {} }
    );
    await sdk.init();
    expect(sdk.api.nodes.urls).toEqual([C]);
    expect(sdk.api.sequencer.getBaseUrl()).toBe(C);
    expect(sdk.nodeChecks.map(c => [c.status, c.reason])).toEqual([
      ['down', 'down: fetch failed'],
      ['observer', 'observer'],
      ['usable', undefined],
    ]);
    expect(sdk.nodeChecks[1].info?.observer).toBe(true);
  });

  it('succeeds with every node down; calls that need a node name them', async () => {
    const chain = deploy(new MockChain(), GNOSIS.processRegistry, {
      setProcessStatus: () => [],
    });
    const { sdk } = sdkWith(
      { signer: new Wallet(KEY, chain), sequencerUrls: [A, B, C] },
      { [A]: 'down', [B]: { observer: true, sequencerAddress: null }, [C]: 503 }
    );
    await sdk.init();
    expect(sdk.nodeChecks.map(c => c.status)).toEqual(['down', 'observer', 'down']);

    // Organizer work that needs no node goes on.
    expect((await sdk.getProcess(PID)).processId).toBe(PID);
    await sdk.endProcess(PID);
    expect(chain.sent).toHaveLength(1);

    const err = (await errorOf(sdk.getVoteStatus(PID, `0x8${'0'.repeat(15)}`))) as Error;
    expect(err).toBeInstanceOf(SequencerUnavailableError);
    expect(err.message).toBe(
      `no usable sequencer node: ${A} (down: fetch failed), ${B} (observer), ${C} (down: nope)`
    );
    expect((err as SequencerUnavailableError).nodes.map(n => n.url)).toEqual([A, B, C]);
    await expect(sdk.listProcesses()).rejects.toThrow(SequencerUnavailableError);
    await expect(sdk.isAddressAbleToVote(PID, `0x${'01'.repeat(20)}`)).rejects.toThrow(
      'no usable sequencer node'
    );
    // The key node defaults to a vote node: none is left for keys either.
    expect(() => sdk.api.sequencer).toThrow(`no usable key sequencer: ${A} (down: fetch failed)`);
  });

  it('fails on a URL that answers but is not a sequencer', async () => {
    for (const spec of [404, 'garbage'] as const) {
      const { sdk } = sdkWith({}, { [A]: {}, [B]: spec });
      const err = await errorOf(sdk.init());
      expect(err).toBeInstanceOf(SequencerError);
      expect((err as Error).message).toContain(`sequencer ${B}: /info:`);
    }
  });

  it('takes a key sequencer apart from the vote nodes, each role failing on its own', async () => {
    const both = sdkWith({ keySequencerUrl: C }, { [A]: {}, [B]: {}, [C]: {} });
    await both.sdk.init();
    expect(both.sdk.api.sequencer.getBaseUrl()).toBe(C);
    expect(both.sdk.api.nodes.urls).toEqual([A, B]);

    const alone = sdkWith({ sequencerUrls: undefined, keySequencerUrl: C }, { [C]: {} });
    await alone.sdk.init();
    expect(alone.sdk.api.nodes.urls).toEqual([C]);

    for (const [spec, reason] of [
      [{ observer: true }, 'observer'],
      ['down', 'down: fetch failed'],
    ] as const) {
      const keyDown = sdkWith({ keySequencerUrl: C }, { [A]: {}, [B]: {}, [C]: spec });
      await keyDown.sdk.init();
      expect(keyDown.sdk.api.nodes.urls).toEqual([A, B]);
      expect(() => keyDown.sdk.api.sequencer).toThrow(`no usable key sequencer: ${C} (${reason})`);
    }

    // Vote nodes down, key node up: keys still come, votes do not go elsewhere.
    const votesDown = sdkWith({ keySequencerUrl: C }, { [A]: 'down', [B]: 'down', [C]: {} });
    await votesDown.sdk.init();
    expect(votesDown.sdk.api.sequencer.getBaseUrl()).toBe(C);
    expect(() => votesDown.sdk.api.nodes).toThrow(
      `no usable sequencer node: ${A} (down: fetch failed), ${B} (down: fetch failed)`
    );
  });

  it('can be retried after a failure', async () => {
    const specs: Record<string, NodeSpec> = { [A]: {}, [B]: { chainId: 1 } };
    const { sdk } = sdkWith({}, specs);
    await expect(sdk.init()).rejects.toThrow(NodeMismatchError);
    specs[B] = {};
    await sdk.init();
    expect(sdk.api.nodes.urls).toEqual([A, B]);
  });

  it('takes the chain of a deprecated addresses.processRegistry from the RPC', async () => {
    const chain = deploy(new MockChain(31337n), LOCAL_REGISTRY);
    const { sdk } = sdkWith(
      {
        signer: new Wallet(KEY, chain),
        addresses: { processRegistry: LOCAL_REGISTRY },
      },
      {
        [A]: { chainId: 31337, processRegistry: LOCAL_REGISTRY },
        [B]: { chainId: 31337, processRegistry: LOCAL_REGISTRY },
      }
    );
    expect(sdk.getConfig().network).toBeUndefined();
    await sdk.init();
    expect(sdk.network).toMatchObject({
      name: 'chain 31337',
      chainId: 31337,
      processRegistry: LOCAL_REGISTRY,
      processIdPrefix: processIdPrefix(31337, LOCAL_REGISTRY),
    });
    expect(sdk.getConfig().network).toBe(sdk.network);
    expect(sdk.processes.address).toBe(LOCAL_REGISTRY);
  });
});

describe('DavinciSDK read provider', () => {
  it("reads through the preset's RPCs for a voter without a provider", async () => {
    const chain = deploy(new MockChain());
    const seen = rpcRoutes({ 'gnosis-rpc.publicnode.com': chain });
    const { sdk } = sdkWith({ signer: Wallet.createRandom() });
    await sdk.init();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map(s => s.host))).toEqual(new Set(['gnosis-rpc.publicnode.com']));
    expect(seen[0].userAgent).toBe('davinci-sdk');
    expect(sdk.provider).toBeInstanceOf(FailoverRpcProvider);
    expect((sdk.provider as FailoverRpcProvider).urls).toEqual(GNOSIS.rpcUrls);
    // A voter reads processes without a provider of its own.
    expect((await sdk.getProcess(PID)).processId).toBe(PID);
  });

  it('prefers rpcUrls, and skips a signer provider on another chain', async () => {
    const own = deploy(new MockChain());
    const rpc = deploy(new MockChain());
    rpcRoutes({ 'rpc.test': rpc });
    const { sdk } = sdkWith({ signer: new Wallet(KEY, own), rpcUrls: ['https://rpc.test'] });
    await sdk.init();
    expect(own.calls('eth_call')).toHaveLength(0);
    expect(rpc.calls('eth_call').length).toBeGreaterThan(0);
    expect((sdk.provider as FailoverRpcProvider).urls).toEqual(['https://rpc.test']);

    const preset = deploy(new MockChain());
    rpcRoutes({ 'gnosis-rpc.publicnode.com': preset });
    const elsewhere = new MockChain(1n);
    const other = sdkWith({ signer: new Wallet(KEY, elsewhere) });
    await other.sdk.init();
    expect(elsewhere.calls('eth_call')).toHaveLength(0);
    expect(preset.calls('eth_call').length).toBeGreaterThan(0);
  });

  it('needs an RPC for a custom network', async () => {
    const { sdk } = sdkWith({
      signer: Wallet.createRandom(),
      network: { chainId: 31337, processRegistry: LOCAL_REGISTRY },
    });
    await expect(sdk.init()).rejects.toThrow(
      'no RPC to read the chain 31337 registry (chain 31337): set rpcUrls'
    );
  });
});

describe('DavinciSDK process routing', () => {
  it("serves the network's process ids and names the network of others", async () => {
    const { sdk } = sdkWith({});
    await sdk.init();
    expect((await sdk.getProcess(PID)).processId).toBe(PID);
    await expect(sdk.getProcess(pidWith('0xdeadbeef'))).rejects.toThrow(
      `Process ${pidWith('0xdeadbeef')} was not created by the gnosis registry (prefix 0xdeadbeef, want 0xf5848002).`
    );
    await expect(sdk.endProcess(pidWith('0xdeadbeef'))).rejects.toThrow('was not created by');
    await expect(sdk.getProcess('0x1234')).rejects.toThrow(TypeError);

    const chain = deploy(new MockChain(31337n), LOCAL_REGISTRY);
    const local = sdkWith(
      {
        signer: new Wallet(KEY, chain),
        network: { chainId: 31337, processRegistry: LOCAL_REGISTRY },
      },
      {
        [A]: { chainId: 31337, processRegistry: LOCAL_REGISTRY },
        [B]: { chainId: 31337, processRegistry: LOCAL_REGISTRY },
      }
    );
    await local.sdk.init();
    await expect(local.sdk.getProcess(PID)).rejects.toThrow(
      `Process ${PID} belongs to gnosis (chain 100); this SDK works with chain 31337 (chain 31337).`
    );
  });

  it("sends organizer transactions only from the network's chain", async () => {
    const rpc = deploy(new MockChain());
    rpcRoutes({ 'rpc.test': rpc });
    const elsewhere = sdkWith({
      signer: new Wallet(KEY, new MockChain(1n)),
      rpcUrls: ['https://rpc.test'],
    });
    await elsewhere.sdk.init();
    await expect(elsewhere.sdk.endProcess(PID)).rejects.toThrow(
      'The signer is on chain 1; the gnosis registry is on chain 100.'
    );
    await expect(elsewhere.sdk.createProcess({} as never)).rejects.toThrow(
      'The signer is on chain 1'
    );
    expect(() => elsewhere.sdk.processes).toThrow(
      'The signer is on chain 1; the gnosis registry is on chain 100.'
    );
    expect(() => elsewhere.sdk.processOrchestrator).toThrow('The signer is on chain 1');

    const voter = sdkWith({ signer: Wallet.createRandom(), rpcUrls: ['https://rpc.test'] });
    await voter.sdk.init();
    await expect(voter.sdk.pauseProcess(PID)).rejects.toThrow('Provider required');
    expect(() => voter.sdk.processes).toThrow('Provider required');
  });

  it('lists the processes of the nodes, on the network chain only', async () => {
    const { sdk, node } = sdkWith({}, { [A]: 'down', [B]: {} });
    await sdk.init();
    expect(await sdk.listProcesses()).toEqual([PID]);
    expect(await sdk.listProcesses(100)).toEqual([PID]);
    expect(node.seen).toContain(`${B}/processes`);
    await expect(sdk.listProcesses(1)).rejects.toThrow(
      'This SDK works with gnosis (chain 100), not chain 1.'
    );
  });
});

describe('DavinciSDK ballot proving', () => {
  it("proves under the registry's ballot VK hash", async () => {
    // A registry (and its nodes) pinning another ballot key than this release.
    const key = `0x${'5b'.repeat(32)}`;
    const chain = deploy(new MockChain(), GNOSIS.processRegistry, { ballotVKHash: () => [key] });
    const { sdk } = sdkWith(
      { signer: new Wallet(KEY, chain), verifyDeployment: false },
      { [A]: { ballotVkHash: key }, [B]: { ballotVkHash: key } }
    );
    const ballot = {
      circuitInputs: {} as never,
      publicSignals: [1n, 2n, 3n] as [bigint, bigint, bigint],
    };
    await expect(sdk.proveBallot(ballot)).rejects.toThrow('SDK must be initialized');
    await sdk.init();
    const proved = {
      proof: {} as never,
      publicSignals: ['1', '2', '3'] as [string, string, string],
    };
    const prove = vi.spyOn(sdk.ballotProver, 'prove').mockResolvedValue(proved);
    expect(await sdk.proveBallot(ballot)).toBe(proved);
    expect(prove).toHaveBeenCalledWith(ballot, key);
    expect(sdk.ballotProver).toBe(sdk.ballotProver);
  });

  it('exposes the uploader as configured', () => {
    const uploader = { upload: vi.fn(() => Promise.resolve('https://files.example/x.json')) };
    expect(sdkWith({ uploader }).sdk.uploader).toBe(uploader);
    expect(sdkWith({}).sdk.uploader).toBeUndefined();
  });
});
