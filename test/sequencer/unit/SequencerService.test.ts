import {
  LeanIMT,
  bjjMulBase,
  censusLeaf,
  elgamalEncrypt,
  IDENTITY_CIPHERTEXT,
} from '../../../src/crypto';
import {
  SequencerApiError,
  SequencerDecodeError,
  SequencerErrorCode,
  SequencerNetworkError,
  VocdoniSequencerService,
  VoteRequest,
  VoteStatus,
} from '../../../src/sequencer';
import { readFixture } from '../../helpers/fixtures';

interface Seen {
  method: string;
  url: string;
  body?: unknown;
}

type Handler = (req: Seen, signal?: AbortSignal | null) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const apiError = (status: number, code: number, error: string) => json({ error, code }, status);

function node(handler: Handler, config: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Seen = {
      method: init?.method ?? 'GET',
      url: String(input),
      ...(typeof init?.body === 'string' && { body: JSON.parse(init.body) as unknown }),
    };
    seen.push(req);
    return handler(req, init?.signal);
  }) as typeof fetch;
  return {
    service: new VocdoniSequencerService('https://node.test/', { fetchImpl, ...config }),
    seen,
  };
}

const PID = `0x${'AB'.repeat(31)}`;
const pid = PID.toLowerCase();
const VOTER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const voter = VOTER.toLowerCase();

const wire = JSON.parse(readFixture('sequencer/wire.json')) as Record<string, unknown>;

describe('VocdoniSequencerService', () => {
  it('calls every route with canonical ids and decodes the answer', async () => {
    const { service, seen } = node(req => {
      if (req.url.endsWith('/ping')) return new Response('pong');
      if (req.url.endsWith('/info')) return json((wire.info as { sequencer: unknown }).sequencer);
      if (req.url.endsWith('/processes')) return json({ processes: [pid] });
      if (req.url.includes('/transitions/3/blobs')) return json(wire.blobs);
      if (req.url.endsWith('/transitions')) return json(wire.transitions);
      if (req.url.includes('/address/')) return json(wire.ballot);
      if (req.url.includes('/voteId/')) return json({ status: 'settled' });
      return json((wire.processView as { ready: unknown }).ready);
    });
    await service.ping();
    expect((await service.getInfo()).chainId).toBe(31337);
    expect(await service.listProcesses()).toEqual([pid]);
    expect((await service.getProcess(PID)).status).toBe('ready');
    expect(await service.getTransitions(PID)).toHaveLength(2);
    expect(await service.getTransitionBlobs(PID, 3)).toEqual(['0x0102', '0xabcdef']);
    expect((await service.getBallot(PID, VOTER)).ballot).toHaveLength(16);
    expect(await service.getVoteStatus(PID, 0x8000000000000001n)).toEqual({
      status: VoteStatus.Settled,
    });
    expect(await service.getVoteStatus(PID, '0x8000000000000001')).toEqual({
      status: VoteStatus.Settled,
    });
    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual([
      'GET https://node.test/ping',
      'GET https://node.test/info',
      'GET https://node.test/processes',
      `GET https://node.test/processes/${pid}`,
      `GET https://node.test/processes/${pid}/transitions`,
      `GET https://node.test/processes/${pid}/transitions/3/blobs`,
      `GET https://node.test/votes/${pid}/address/${voter}`,
      `GET https://node.test/votes/${pid}/voteId/0x8000000000000001`,
      `GET https://node.test/votes/${pid}/voteId/0x8000000000000001`,
    ]);
  });

  it('refuses malformed ids before asking', () => {
    const { service, seen } = node(() => json({}));
    expect(() => service.getProcess('0x01')).toThrow(TypeError);
    expect(() => service.getBallot(PID, '0x1234')).toThrow(TypeError);
    expect(() => service.getVoteStatus(PID, 5n)).toThrow(RangeError);
    expect(() => service.getTransitionBlobs(PID, -1)).toThrow(RangeError);
    expect(seen).toHaveLength(0);
  });

  it('maps error answers to SequencerApiError with their code', async () => {
    const { service } = node(() => apiError(404, 40402, 'unknown process'));
    const err = await service.getProcess(PID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SequencerApiError);
    expect(err).toMatchObject({
      status: 404,
      code: SequencerErrorCode.UnknownProcess,
      message: 'unknown process',
      node: 'https://node.test/',
    });

    const text = node(() => new Response('x'.repeat(5000), { status: 502 }));
    const bad = (await text.service.getInfo().catch((e: unknown) => e)) as SequencerApiError;
    expect(bad).toBeInstanceOf(SequencerApiError);
    expect(bad.status).toBe(502);
    expect(bad.code).toBeUndefined();
    expect(bad.message).toHaveLength(4096);
  });

  it('reports no answer as SequencerNetworkError, timeouts included', async () => {
    const down = node(() => Promise.reject(new TypeError('fetch failed')));
    const err = (await down.service.getInfo().catch((e: unknown) => e)) as SequencerNetworkError;
    expect(err).toBeInstanceOf(SequencerNetworkError);
    expect(err.timedOut).toBe(false);

    const slow = node(
      (_req, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        }),
      { timeoutMs: 20 }
    );
    const timeout = (await slow.service
      .getInfo()
      .catch((e: unknown) => e)) as SequencerNetworkError;
    expect(timeout).toBeInstanceOf(SequencerNetworkError);
    expect(timeout.timedOut).toBe(true);
  });

  it('stops reading a body past the cap', async () => {
    const { service } = node(() => json({ blobs: ['0x' + 'ab'.repeat(2000)] }), {
      maxResponseBytes: 1000,
    });
    await expect(service.getTransitionBlobs(PID, 0)).rejects.toBeInstanceOf(SequencerNetworkError);
  });

  it('decodes strictly and names the node', async () => {
    const { service } = node(() => json({ processes: ['0x01'] }));
    const err = (await service.listProcesses().catch((e: unknown) => e)) as SequencerDecodeError;
    expect(err).toBeInstanceOf(SequencerDecodeError);
    expect(err.node).toBe('https://node.test/');
  });

  it('asks for a key and keeps only prime-order ones', async () => {
    const cases = wire.newKeyCases as { label: string; json: unknown; ok: boolean }[];
    for (const c of cases) {
      const { service, seen } = node(() => json(c.json));
      const got = await service.getEncryptionKey(PID).then(
        () => true,
        (e: unknown) => {
          expect(e).toBeInstanceOf(SequencerDecodeError);
          return false;
        }
      );
      expect(got, c.label).toBe(c.ok);
      expect(seen[0]).toEqual({
        method: 'POST',
        url: 'https://node.test/processes/keys',
        body: { processId: pid },
      });
    }
    const { service } = node(() => apiError(412, 41203, 'observer node: no keys'));
    await expect(service.getEncryptionKey(PID)).rejects.toMatchObject({
      code: SequencerErrorCode.ObserverNode,
    });
  });

  it("accepts a participant proof only for the address's own leaf", async () => {
    const members = [VOTER, `0x${'22'.repeat(20)}`, `0x${'33'.repeat(20)}`];
    const tree = await LeanIMT.create(members.map((a, i) => censusLeaf(a, BigInt(i + 5))));
    const answer = (address: string, weight: bigint, index: number) => {
      const p = tree.proof(index);
      return {
        address,
        weight: weight.toString(),
        censusProof: {
          root: p.root.toString(),
          leaf: p.leaf.toString(),
          pathBits: Number(p.pathBits),
          siblings: p.siblings.map(s => s.toString()),
        },
      };
    };
    const honest = node(() => json(answer(voter, 5n, 0)));
    const p = await honest.service.getParticipant(PID, VOTER);
    expect(p.weight).toBe(5n);
    expect(p.censusProof.root).toBe(tree.root);
    expect(await honest.service.getAddressWeight(PID, VOTER)).toBe(5n);
    expect(await honest.service.isAddressAbleToVote(PID, VOTER)).toBe(true);

    const lies = [
      answer(voter, 6n, 0), // weight of another leaf
      answer(voter, 6n, 1), // another member's proof
      answer(`0x${'22'.repeat(20)}`, 6n, 1), // another address
      {
        ...answer(voter, 5n, 0),
        censusProof: { ...answer(voter, 5n, 0).censusProof, pathBits: 1 },
      },
    ];
    for (const lie of lies) {
      const { service } = node(() => json(lie));
      await expect(service.getParticipant(PID, VOTER)).rejects.toBeInstanceOf(SequencerDecodeError);
    }

    const outside = node(() => apiError(404, 40401, 'not found'));
    expect(await outside.service.isAddressAbleToVote(PID, VOTER)).toBe(false);
    const unknown = node(() => apiError(404, 40402, 'unknown process'));
    await expect(unknown.service.isAddressAbleToVote(PID, VOTER)).rejects.toBeInstanceOf(
      SequencerApiError
    );
  });

  it('tells whether the node holds a ballot for the address', async () => {
    const held = node(() => json(wire.ballot));
    expect(await held.service.hasAddressVoted(PID, VOTER)).toBe(true);
    const none = node(() => apiError(404, 40401, 'not found'));
    expect(await none.service.hasAddressVoted(PID, VOTER)).toBe(false);
    const malformed = node(() => apiError(400, 40001, 'want a 20-byte hex address'));
    await expect(malformed.service.hasAddressVoted(PID, VOTER)).rejects.toMatchObject({
      code: SequencerErrorCode.MalformedRequest,
    });
  });

  const vote = (): VoteRequest => {
    const pk = bjjMulBase(99n);
    const ballot = Array.from({ length: 16 }, () => ({ ...IDENTITY_CIPHERTEXT }));
    ballot[0] = elgamalEncrypt(pk, 1n, 5n);
    return {
      processId: PID,
      address: VOTER,
      voteId: 0x8000000000000abcn,
      ballot,
      ballotProof: {
        pi_a: ['1', '2', '1'],
        pi_b: [
          ['1', '2'],
          ['3', '4'],
          ['1', '0'],
        ],
        pi_c: ['5', '6', '1'],
        protocol: 'groth16',
      },
      ballotInputsHash: 7n,
      signature: `0x${'09'.repeat(65)}`,
      weight: 3n,
    };
  };

  it('posts the exact vote body and checks the acknowledged vote id', async () => {
    const { service, seen } = node(() => json({ voteId: '0x8000000000000abc' }));
    await service.submitVote(vote());
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('https://node.test/votes');
    const body = seen[0].body as Record<string, unknown>;
    expect(body.processId).toBe(pid);
    expect(body.address).toBe(voter);
    expect(body.weight).toBe('3');
    expect((body.ballotProof as { curve: string }).curve).toBe('bn128');
    expect(body.ballot).toHaveLength(16);

    const other = node(() => json({ voteId: '0x8000000000000abd' }));
    await expect(other.service.submitVote(vote())).rejects.toThrow(
      'sequencer acknowledged another vote id'
    );
  });

  it('checks the tracker proof is for the vote asked about', async () => {
    const proof = (voteId: string, processId = pid) => ({
      processId,
      voteId,
      root: `0x${'0c'.repeat(32)}`,
      siblings: [],
    });
    const { service, seen } = node(() => json(proof('0x8000000000004321')));
    const p = await service.getVoteIdProof(PID, 0x8000000000004321n);
    expect(p.voteId).toBe(0x8000000000004321n);
    expect(seen[0].url).toBe(`https://node.test/votes/${pid}/voteId/0x8000000000004321/proof`);
    for (const lie of [
      proof('0x8000000000004322'),
      proof('0x8000000000004321', `0x${'cd'.repeat(31)}`),
    ]) {
      const n = node(() => json(lie));
      await expect(n.service.getVoteIdProof(PID, 0x8000000000004321n)).rejects.toThrow(
        'tracker proof for another vote'
      );
    }
  });
});
