import { Signer } from 'ethers';
import { DavinciSDK } from '../../../src/DavinciSDK';
import type { ProcessRegistryService } from '../../../src/contracts';
import { GNOSIS, processIdPrefix } from '../../../src/networks';

type MutableChain = { value: bigint };

const NODE_REGISTRY = '0x015eAc820688DA203a0bd730a8a7A4CDB97E1a02';
const NODE_CHAIN = 31337;

function createMockSigner(chain: MutableChain): Signer {
  const provider = {
    getNetwork: vi.fn(() => Promise.resolve({ chainId: chain.value })),
  };
  return { provider, getAddress: vi.fn() } as unknown as Signer;
}

function createBareSigner(): Signer {
  return { provider: null, getAddress: vi.fn() } as unknown as Signer;
}

// A node on chain 31337 serving NODE_REGISTRY; counts its /info requests.
function stubNode(processes: string[] = []) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      seen.push(`${url.pathname}${url.search}`);
      const body =
        url.pathname === '/info'
          ? {
              sequencerAddress: '0x70debac0bf6fcc5f99646fcbcffb6d8267184dec',
              chainId: NODE_CHAIN,
              processRegistry: NODE_REGISTRY,
              ballotVkHash: `0x${'03'.repeat(32)}`,
              batchProgramVk: `0x${'04'.repeat(32)}`,
              resultsProgramVk: `0x${'05'.repeat(32)}`,
              observer: false,
              settledBySelf: 0,
              syncedFromOthers: 0,
              lostRaces: 0,
            }
          : { processes };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }) as typeof fetch
  );
  return seen;
}

// The facade's private registry resolution.
interface Routing {
  getProcessRegistryForCurrentChain(): Promise<ProcessRegistryService>;
  getProcessRegistryForProcessId(processId: string): Promise<ProcessRegistryService>;
}
const routing = (sdk: DavinciSDK) => sdk as unknown as Routing;

// 20-byte creator + 4-byte registry prefix + 7-byte nonce.
const pidWith = (prefix: string) => `0x${'aa'.repeat(20)}${prefix.slice(2)}${'bb'.repeat(7)}`;

const PID = `0x${'ab'.repeat(31)}`;

describe('DavinciSDK Multichain Consumer Behavior', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listProcesses() lists what the node knows, on the signer chain', async () => {
    const seen = stubNode([PID]);
    const sdk = new DavinciSDK({
      signer: createMockSigner({ value: BigInt(NODE_CHAIN) }),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();
    expect(await sdk.listProcesses()).toEqual([PID]);
    // One deployment per node: no chain filter in the query.
    expect(seen).toContain('/processes');
  });

  it('listProcesses() refuses a chain the node does not serve', async () => {
    stubNode([PID]);
    const sdk = new DavinciSDK({
      signer: createBareSigner(),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();
    await expect(sdk.listProcesses(100)).rejects.toThrow(
      'The sequencer serves chainId 31337, not 100.'
    );
    expect(await sdk.listProcesses(NODE_CHAIN)).toEqual([PID]);
    expect(await sdk.listProcesses()).toEqual([PID]);
  });

  it('resolves a known network from its preset, without asking the node', async () => {
    const seen = stubNode();
    const sdk = new DavinciSDK({
      signer: createMockSigner({ value: BigInt(GNOSIS.chainId) }),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();
    const registry = await routing(sdk).getProcessRegistryForCurrentChain();
    expect(registry.address).toBe(GNOSIS.processRegistry);
    expect(seen).toHaveLength(0);
  });

  it("resolves the node's own deployment on its chain, and a new registry when the chain changes", async () => {
    stubNode();
    const chain = { value: BigInt(NODE_CHAIN) };
    const sdk = new DavinciSDK({
      signer: createMockSigner(chain),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();
    const registryA = await routing(sdk).getProcessRegistryForCurrentChain();
    chain.value = BigInt(GNOSIS.chainId);
    const registryB = await routing(sdk).getProcessRegistryForCurrentChain();
    expect(registryA.address).toBe(NODE_REGISTRY);
    expect(registryB.address).toBe(GNOSIS.processRegistry);
  });

  it('throws when neither a preset nor the node serves the signer chain', async () => {
    stubNode();
    const sdk = new DavinciSDK({
      signer: createMockSigner({ value: 1n }),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await expect(sdk.init()).rejects.toThrow(
      'Signer chainId 1 is not supported by sequencer. Available chainIds: 100,31337'
    );
  });

  it('routes a process id by its registry prefix, whatever the signer chain', async () => {
    const seen = stubNode();
    const sdk = new DavinciSDK({
      signer: createMockSigner({ value: 1n }),
      sequencerUrl: 'https://sequencer.example.test',
    });

    const gnosis = pidWith(processIdPrefix(GNOSIS.chainId, GNOSIS.processRegistry));
    expect((await routing(sdk).getProcessRegistryForProcessId(gnosis)).address).toBe(
      GNOSIS.processRegistry
    );
    expect(seen).toHaveLength(0);

    const local = pidWith(processIdPrefix(NODE_CHAIN, NODE_REGISTRY));
    expect((await routing(sdk).getProcessRegistryForProcessId(local)).address).toBe(NODE_REGISTRY);

    await expect(
      routing(sdk).getProcessRegistryForProcessId(pidWith('0xdeadbeef'))
    ).rejects.toThrow('Process ID version 0xdeadbeef is not supported by sequencer');
  });
});
