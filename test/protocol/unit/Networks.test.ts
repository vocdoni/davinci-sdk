import {
  FetchRequest,
  Interface,
  toUtf8Bytes,
  toUtf8String,
  type FetchGetUrlFunc,
  type GetUrlResponse,
  type JsonRpcPayload,
} from 'ethers';
import {
  FailoverRpcProvider,
  GNOSIS,
  networkOfProcessId,
  processIdPrefixOf,
  resolveNetwork,
} from '../../../src/networks';
import { PROCESS_REGISTRY_ABI } from '../../../src/contracts';

const LOCAL_REGISTRY = '0x015eAc820688DA203a0bd730a8a7A4CDB97E1a02';
const pidWith = (prefix: string) => `0x${'aa'.repeat(20)}${prefix.slice(2)}${'bb'.repeat(7)}`;
const GNOSIS_PID = pidWith('0xf5848002');

describe('resolveNetwork', () => {
  it('resolves a known network by name', () => {
    const net = resolveNetwork(' Gnosis ');
    expect(net).toEqual({
      name: 'gnosis',
      chainId: 100,
      processRegistry: GNOSIS.processRegistry,
      startBlock: GNOSIS.startBlock,
      rpcUrls: GNOSIS.rpcUrls,
      processIdPrefix: '0xf5848002',
    });
    expect(() => resolveNetwork('sepolia')).toThrow('unknown network "sepolia"; known: gnosis');
  });

  it('checks a custom deployment and fills in what a known one sets', () => {
    const local = resolveNetwork({
      chainId: 31337,
      processRegistry: LOCAL_REGISTRY.toLowerCase(),
      rpcUrls: ['http://127.0.0.1:8545'],
    });
    expect(local).toEqual({
      name: 'chain 31337',
      chainId: 31337,
      processRegistry: LOCAL_REGISTRY,
      startBlock: undefined,
      rpcUrls: ['http://127.0.0.1:8545'],
      processIdPrefix: local.processIdPrefix,
    });
    expect(local.processIdPrefix).toMatch(/^0x[0-9a-f]{8}$/);

    // The Gnosis registry given by address takes the preset's other settings.
    const gnosis = resolveNetwork({
      chainId: 100,
      processRegistry: GNOSIS.processRegistry.toLowerCase(),
    });
    expect(gnosis).toEqual(resolveNetwork('gnosis'));
    expect(
      resolveNetwork({ name: 'mine', chainId: 100, processRegistry: GNOSIS.processRegistry }).name
    ).toBe('mine');

    for (const chainId of [0, -1, 1.5, 2 ** 32]) {
      expect(() => resolveNetwork({ chainId, processRegistry: LOCAL_REGISTRY })).toThrow(
        RangeError
      );
    }
    expect(() =>
      resolveNetwork({ chainId: 1, processRegistry: LOCAL_REGISTRY, startBlock: -1 })
    ).toThrow('start block');
    expect(() => resolveNetwork({ chainId: 1, processRegistry: '0x1234' })).toThrow();
  });
});

describe('process id prefixes', () => {
  it('read bytes 20..23 and name the known network', () => {
    expect(processIdPrefixOf(GNOSIS_PID)).toBe('0xf5848002');
    expect(processIdPrefixOf(GNOSIS_PID.slice(2).toUpperCase())).toBe('0xf5848002');
    expect(networkOfProcessId(GNOSIS_PID)).toBe(GNOSIS);
    expect(networkOfProcessId(pidWith('0xdeadbeef'))).toBeUndefined();
    expect(() => processIdPrefixOf('0x1234')).toThrow(TypeError);
  });
});

// Answers RPC requests by host; records every request.
type Answer = (payload: JsonRpcPayload) => GetUrlResponse | Error;

function rpcHosts(answers: Record<string, Answer>) {
  const seen: { host: string; method: string; headers: Record<string, string> }[] = [];
  const getUrl: FetchGetUrlFunc = req => {
    const host = new URL(req.url).host;
    const payload = JSON.parse(toUtf8String(req.body ?? new Uint8Array())) as JsonRpcPayload;
    seen.push({ host, method: payload.method, headers: req.headers });
    const answer = answers[host]?.(payload) ?? new Error(`no route to ${host}`);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  FetchRequest.registerGetUrl(getUrl);
  return seen;
}

const json = (body: unknown, statusCode = 200): GetUrlResponse => ({
  statusCode,
  statusMessage: statusCode === 200 ? 'OK' : 'ERR',
  headers: { 'content-type': 'application/json' },
  body: toUtf8Bytes(JSON.stringify(body)),
});
const result = (value: unknown) => (p: JsonRpcPayload) =>
  json({ jsonrpc: '2.0', id: p.id, result: value });
const rpcError = (code: number, message: string, data?: string) => (p: JsonRpcPayload) =>
  json({ jsonrpc: '2.0', id: p.id, error: { code, message, ...(data && { data }) } });

describe('FailoverRpcProvider', () => {
  afterEach(() => {
    FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc());
  });

  const urls = ['https://a.rpc.test', 'https://b.rpc.test', 'https://c.rpc.test'];

  it('takes the first answer, with a User-Agent from Node and no chain id request', async () => {
    const seen = rpcHosts({ 'a.rpc.test': result('0x10') });
    const provider = new FailoverRpcProvider(urls, 100);
    expect(await provider.getBlockNumber()).toBe(16);
    expect((await provider.getNetwork()).chainId).toBe(100n);
    expect(seen.map(s => `${s.host} ${s.method}`)).toEqual(['a.rpc.test eth_blockNumber']);
    expect(seen[0].headers['user-agent']).toBe('davinci-sdk');
    expect(seen[0].headers['content-type']).toBe('application/json');
  });

  it('detects the chain id when none is given', async () => {
    rpcHosts({ 'a.rpc.test': result('0x7a69') });
    const provider = new FailoverRpcProvider(['https://a.rpc.test']);
    expect((await provider.getNetwork()).chainId).toBe(31337n);
  });

  it('moves on when an endpoint does not answer, fails or rate-limits', async () => {
    const seen = rpcHosts({
      'a.rpc.test': () => new Error('connect ECONNREFUSED'),
      'b.rpc.test': () => json({ error: 'bad gateway' }, 502),
      'c.rpc.test': result('0x2a'),
    });
    expect(await new FailoverRpcProvider(urls, 100).getBlockNumber()).toBe(42);
    expect(seen.map(s => s.host)).toEqual(['a.rpc.test', 'b.rpc.test', 'c.rpc.test']);

    for (const limited of [
      rpcError(-32005, 'limit exceeded'),
      rpcError(429, 'Too Many Requests'),
      rpcError(-32000, 'daily request count exceeded, request rate limited'),
    ]) {
      const again = rpcHosts({ 'a.rpc.test': limited, 'b.rpc.test': result('0x2b') });
      expect(await new FailoverRpcProvider(urls.slice(0, 2), 100).getBlockNumber()).toBe(43);
      expect(again.map(s => s.host)).toEqual(['a.rpc.test', 'b.rpc.test']);
    }
  });

  it('retries a 429 a few times before the next endpoint', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const seen = rpcHosts({
      'a.rpc.test': () => json({}, 429),
      'b.rpc.test': result('0x2c'),
    });
    expect(await new FailoverRpcProvider(urls.slice(0, 2), 100).getBlockNumber()).toBe(44);
    expect(seen.map(s => s.host)).toEqual([...Array<string>(4).fill('a.rpc.test'), 'b.rpc.test']);
  });

  it('returns a JSON-RPC error answer as it is, and the last endpoint answer', async () => {
    const iface = new Interface(PROCESS_REGISTRY_ABI);
    const revert = iface.encodeErrorResult('ProcessNotFound', []);
    const seen = rpcHosts({ 'a.rpc.test': rpcError(3, 'execution reverted', revert) });
    const provider = new FailoverRpcProvider(urls, 100);
    await expect(provider.call({ to: LOCAL_REGISTRY, data: '0x' })).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
      data: revert,
    });
    expect(seen.map(s => s.host)).toEqual(['a.rpc.test']);

    rpcHosts({
      'a.rpc.test': () => new Error('down'),
      'b.rpc.test': rpcError(-32005, 'limit exceeded'),
    });
    await expect(new FailoverRpcProvider(urls.slice(0, 2), 100).getBlockNumber()).rejects.toThrow(
      'limit exceeded'
    );
    rpcHosts({});
    await expect(new FailoverRpcProvider(urls, 100).getBlockNumber()).rejects.toThrow(
      'no route to c.rpc.test'
    );
  });

  it('needs an endpoint', () => {
    expect(() => new FailoverRpcProvider([])).toThrow('at least one RPC URL');
  });
});
