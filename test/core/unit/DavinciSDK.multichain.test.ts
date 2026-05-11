import { DavinciSDK } from '../../../src/DavinciSDK';
import { Signer } from 'ethers';

type MutableChain = { value: bigint };

function createMockSigner(chain: MutableChain): Signer {
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: chain.value })),
  };

  const signerLike = {
    provider,
    getAddress: vi.fn(async () => '0x1111111111111111111111111111111111111111'),
    signMessage: vi.fn(async () => '0xsigned'),
  };

  return signerLike as unknown as Signer;
}

function createBareSigner(): Signer {
  const signerLike = {
    provider: null,
    getAddress: vi.fn(async () => '0x1111111111111111111111111111111111111111'),
    signMessage: vi.fn(async () => '0xsigned'),
  };

  return signerLike as unknown as Signer;
}

describe('DavinciSDK Multichain Consumer Behavior', () => {
  it('listProcesses() uses signer provider chainId by default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        );
        if (url.pathname === '/info') {
          return new Response(
            JSON.stringify({
              circuitUrl: 'https://circuit',
              circuitHash: 'a'.repeat(64),
              provingKeyUrl: 'https://zkey',
              provingKeyHash: 'b'.repeat(64),
              verificationKeyUrl: 'https://vkey',
              verificationKeyHash: 'c'.repeat(64),
              networks: {
                '11155111': {
                  chainID: 11155111,
                  shortName: 'sep',
                  processRegistryContract: '0x015eAc820688DA203a0bd730a8a7A4CDB97E1a02',
                  processIDVersion: '0xbd9bb825',
                },
              },
              sequencerAddress: '0x70debac0bf6fcc5f99646fcbcffb6d8267184dec',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.pathname === '/processes') {
          if (url.searchParams.get('chainId') !== '11155111') {
            return new Response(JSON.stringify({ error: 'wrong chainId' }), { status: 400 });
          }
          return new Response(JSON.stringify({ processes: ['0xabc'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch
    );

    const chain = { value: 11155111n };
    const sdk = new DavinciSDK({
      signer: createMockSigner(chain),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();

    const result = await sdk.listProcesses();
    expect(result).toEqual(['0xabc']);
  });

  it('listProcesses() throws without provider when chainId is not passed', async () => {
    const sdk = new DavinciSDK({
      signer: createBareSigner(),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();

    await expect(sdk.listProcesses()).rejects.toThrow(
      'chainId is required for listProcesses when signer has no provider.'
    );
  });

  it('listProcesses(chainId) works without provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        );
        if (url.pathname === '/processes') {
          if (url.searchParams.get('chainId') !== '1') {
            return new Response(JSON.stringify({ error: 'wrong chainId' }), { status: 400 });
          }
          return new Response(JSON.stringify({ processes: ['0xdef'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch
    );

    const sdk = new DavinciSDK({
      signer: createBareSigner(),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();

    const result = await sdk.listProcesses(1);
    expect(result).toEqual(['0xdef']);
  });

  it('throws explicit error when signer chain is not supported by sequencer networks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        );
        if (url.pathname === '/info') {
          return new Response(
            JSON.stringify({
              circuitUrl: 'https://circuit',
              circuitHash: 'a'.repeat(64),
              provingKeyUrl: 'https://zkey',
              provingKeyHash: 'b'.repeat(64),
              verificationKeyUrl: 'https://vkey',
              verificationKeyHash: 'c'.repeat(64),
              networks: {
                '11155111': {
                  chainID: 11155111,
                  shortName: 'sep',
                  processRegistryContract: '0x015eAc820688DA203a0bd730a8a7A4CDB97E1a02',
                  processIDVersion: '0xbd9bb825',
                },
              },
              sequencerAddress: '0x70debac0bf6fcc5f99646fcbcffb6d8267184dec',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch
    );

    const chain = { value: 1n };
    const sdk = new DavinciSDK({
      signer: createMockSigner(chain),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await expect(sdk.init()).rejects.toThrow(
      'Signer chainId 1 is not supported by sequencer. Available chainIds: 11155111'
    );
  });

  it('resolves different registry services when provider chain changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        );
        if (url.pathname === '/info') {
          return new Response(
            JSON.stringify({
              circuitUrl: 'https://circuit',
              circuitHash: 'a'.repeat(64),
              provingKeyUrl: 'https://zkey',
              provingKeyHash: 'b'.repeat(64),
              verificationKeyUrl: 'https://vkey',
              verificationKeyHash: 'c'.repeat(64),
              networks: {
                '11155111': {
                  chainID: 11155111,
                  shortName: 'sep',
                  processRegistryContract: '0x015eAc820688DA203a0bd730a8a7A4CDB97E1a02',
                  processIDVersion: '0xbd9bb825',
                },
                '1': {
                  chainID: 1,
                  shortName: 'eth',
                  processRegistryContract: '0x1111111111111111111111111111111111111111',
                  processIDVersion: '0x35bf8a7f',
                },
              },
              sequencerAddress: '0x70debac0bf6fcc5f99646fcbcffb6d8267184dec',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch
    );

    const chain = { value: 11155111n };
    const sdk = new DavinciSDK({
      signer: createMockSigner(chain),
      sequencerUrl: 'https://sequencer.example.test',
    });
    await sdk.init();

    const registryA = await (sdk as any).getProcessRegistryForCurrentChain();
    chain.value = 1n;
    const registryB = await (sdk as any).getProcessRegistryForCurrentChain();

    expect(registryA).toBeDefined();
    expect(registryB).toBeDefined();
    expect(registryA).not.toBe(registryB);
  });

  it('extracts process ID version and resolves registry without relying on signer chain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        );
        if (url.pathname === '/info') {
          return new Response(
            JSON.stringify({
              circuitUrl: 'https://circuit',
              circuitHash: 'a'.repeat(64),
              provingKeyUrl: 'https://zkey',
              provingKeyHash: 'b'.repeat(64),
              verificationKeyUrl: 'https://vkey',
              verificationKeyHash: 'c'.repeat(64),
              networks: {
                '11155111': {
                  chainID: 11155111,
                  shortName: 'sep',
                  processRegistryContract: '0x015eAc820688DA203a0bd730a8a7A4CDB97E1a02',
                  processIDVersion: '0xbd9bb825',
                },
                '421614': {
                  chainID: 421614,
                  shortName: 'arb-sep',
                  processRegistryContract: '0x00521105ad9666110513C96dA26AdDD40ed8aD41',
                  processIDVersion: '0x35bf8a7f',
                },
              },
              sequencerAddress: '0x70debac0bf6fcc5f99646fcbcffb6d8267184dec',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch
    );

    const chain = { value: 1n }; // Intentionally unrelated chain
    const sdk = new DavinciSDK({
      signer: createMockSigner(chain),
      sequencerUrl: 'https://sequencer.example.test',
    });

    // 20-byte addr + 4-byte version + 7-byte nonce = 31 bytes
    const processId =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa35bf8a7fbbbbbbbbbbbbbb';

    const registry = await (sdk as any).getProcessRegistryForProcessId(processId);
    expect(registry).toBeDefined();
  });
});
