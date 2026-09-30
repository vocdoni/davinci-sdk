import {
  FetchRequest,
  Interface,
  Wallet,
  getAddress,
  toUtf8Bytes,
  toUtf8String,
  type FetchGetUrlFunc,
  type GetUrlResponse,
  type JsonRpcPayload,
} from 'ethers';
import {
  FailoverRpcProvider,
  GNOSIS,
  computeProcessId,
  networkOfProcessId,
  processIdPrefix,
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

  it('computes the id a registry assigns an organizer', () => {
    // A process of an earlier Gnosis registry, 0x3CDE…daf3 (davinci-explorer's vector).
    const registry = '0x3CDE68c39E26ecf94bD029b6ED3b9F945441daf3';
    const organizer = getAddress('0x42fc20654efd78c6887ff0bd1cc50c9ec1dab589');
    const prefix = processIdPrefix(100, registry);
    expect(prefix).toBe('0x80c5bb93');
    expect(computeProcessId(organizer, prefix, 1)).toBe(
      '0x42fc20654efd78c6887ff0bd1cc50c9ec1dab58980c5bb9300000000000001'
    );
    expect(computeProcessId(organizer.toLowerCase(), '0x80C5BB93', 0n)).toBe(
      '0x42fc20654efd78c6887ff0bd1cc50c9ec1dab58980c5bb9300000000000000'
    );
    expect(computeProcessId(organizer, prefix, (1n << 56n) - 1n).endsWith('ff'.repeat(7))).toBe(
      true
    );
    expect(() => computeProcessId(organizer, prefix, 1n << 56n)).toThrow(RangeError);
    expect(() => computeProcessId(organizer, prefix, -1)).toThrow(RangeError);
    expect(() => computeProcessId(organizer, '0xf58480', 0)).toThrow(TypeError);
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

  describe('a signed transaction', () => {
    // Answers each call of a (possibly batched) request with `answer(call)`;
    // `hold` keeps a host's eth_sendRawTransaction answer back until released.
    function hosts(
      answer: (host: string, call: JsonRpcPayload) => unknown,
      hold: Record<string, Promise<void>> = {}
    ) {
      const seen: string[] = [];
      FetchRequest.registerGetUrl(async req => {
        const host = new URL(req.url).host;
        const body = JSON.parse(toUtf8String(req.body ?? new Uint8Array())) as
          | JsonRpcPayload
          | JsonRpcPayload[];
        const calls = Array.isArray(body) ? body : [body];
        for (const c of calls) seen.push(`${host} ${c.method}`);
        if (calls.some(c => c.method === 'eth_sendRawTransaction')) await hold[host];
        const answers = calls.map(c => ({
          jsonrpc: '2.0',
          id: c.id,
          ...(answer(host, c) as object),
        }));
        const r = json(Array.isArray(body) ? answers : answers[0]);
        if (host === 'down.rpc.test') throw new Error('connect ECONNREFUSED');
        return r;
      });
      return seen;
    }

    const signed = () =>
      Wallet.createRandom().signTransaction({
        type: 2,
        chainId: 100,
        nonce: 0,
        gasLimit: 21_000,
        to: LOCAL_REGISTRY,
        value: 0,
        maxFeePerGas: 20,
        maxPriorityFeePerGas: 2,
      });

    it('goes to every endpoint at once; the first that takes it answers', async () => {
      const raw = await signed();
      let release = () => undefined as void;
      const held = new Promise<void>(ok => (release = ok));
      const hash = (await import('ethers')).keccak256(raw);
      const seen = hosts(
        (host, c) => {
          if (c.method !== 'eth_sendRawTransaction') return { result: '0x10' };
          if (host === 'b.rpc.test') return { error: { code: -32000, message: 'already known' } };
          return { result: hash };
        },
        { 'a.rpc.test': held }
      );
      const provider = new FailoverRpcProvider(urls, 100);
      // The first endpoint holds it; the third takes it at once.
      const tx = await provider.broadcastTransaction(raw);
      expect(tx.hash).toBe(hash);
      const sends = seen
        .filter(s => s.endsWith('eth_sendRawTransaction'))
        .map(s => s.split(' ')[0]);
      expect(sends.sort()).toEqual(['a.rpc.test', 'b.rpc.test', 'c.rpc.test']);
      // A read on its own still goes to the first endpoint only.
      seen.length = 0;
      expect(await provider.send('eth_blockNumber', [])).toBe('0x10');
      expect(seen).toEqual(['a.rpc.test eth_blockNumber']);
      release();
    });

    it('reads the nonce from every endpoint and takes the highest', async () => {
      const account = Wallet.createRandom().address;
      const counts: Record<string, string> = { 'a.rpc.test': '0x5', 'b.rpc.test': '0x7' };
      const seen = hosts(host =>
        host === 'c.rpc.test'
          ? { error: { code: -32005, message: 'limit exceeded' } }
          : { result: counts[host] }
      );
      const provider = new FailoverRpcProvider(urls, 100);
      expect(await provider.getTransactionCount(account, 'pending')).toBe(7);
      expect(seen.map(s => s.split(' ')[0]).sort()).toEqual([
        'a.rpc.test',
        'b.rpc.test',
        'c.rpc.test',
      ]);

      // An endpoint that does not answer delays the read by a moment only.
      let release = () => undefined as void;
      const held = new Promise<void>(ok => (release = ok));
      FetchRequest.registerGetUrl(async req => {
        const host = new URL(req.url).host;
        const call = JSON.parse(toUtf8String(req.body ?? new Uint8Array())) as JsonRpcPayload;
        if (host === 'b.rpc.test') await held;
        return json({ jsonrpc: '2.0', id: call.id, result: host === 'b.rpc.test' ? '0x9' : '0x5' });
      });
      const t0 = Date.now();
      expect(await provider.getTransactionCount(account, 'latest')).toBe(5);
      expect(Date.now() - t0).toBeLessThan(5_000);
      release();
    });

    it('when no endpoint takes it, answers with the first refusal that is not a rate limit', async () => {
      const raw = await signed();
      hosts((host, c) => {
        if (c.method !== 'eth_sendRawTransaction') return { result: '0x10' };
        if (host === 'a.rpc.test') return { error: { code: -32005, message: 'limit exceeded' } };
        return { error: { code: -32000, message: 'insufficient funds for gas * price + value' } };
      });
      await expect(
        new FailoverRpcProvider(
          ['https://a.rpc.test', 'https://b.rpc.test', 'https://down.rpc.test'],
          100
        ).broadcastTransaction(raw)
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      hosts(() => ({}));
      await expect(
        new FailoverRpcProvider(
          ['https://down.rpc.test', 'https://down.rpc.test'],
          100
        ).broadcastTransaction(raw)
      ).rejects.toThrow('ECONNREFUSED');
    });
  });
});
