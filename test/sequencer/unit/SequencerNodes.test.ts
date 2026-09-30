import { IDENTITY_CIPHERTEXT } from '../../../src/crypto';
import {
  SequencerApiError,
  SequencerErrorCode,
  SequencerNetworkError,
  SequencerNodes,
  VoteRequest,
  pickNode,
} from '../../../src/sequencer';

type Reply = Response | 'down';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: number) => json({ error: `code ${code}`, code }, status);

const URLS = ['https://a.test', 'https://b.test', 'https://c.test'];
const PID = `0x${'ab'.repeat(31)}`;
const VOTER = `0x${'5a'.repeat(20)}`;
const VID = 0x8000000000000abcn;
const ACK = () => json({ voteId: '0x8000000000000abc' });

// Nodes that answer each request from their own script, in order.
function cluster(scripts: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.origin}${url.pathname}`);
    const reply = scripts[url.origin]?.shift();
    if (!reply) return Promise.reject(new Error(`unexpected request to ${url.href}`));
    if (reply === 'down') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(reply);
  }) as typeof fetch;
  return { nodes: new SequencerNodes(URLS, { fetchImpl }), calls };
}

function vote(): VoteRequest {
  return {
    processId: PID,
    address: VOTER,
    voteId: VID,
    ballot: Array.from({ length: 16 }, () => ({ ...IDENTITY_CIPHERTEXT })),
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
}

// The voter's nodes, in order.
const [first, second, third] = pickNode(VOTER, PID, URLS);

describe('SequencerNodes', () => {
  it('sends the vote to the first node of the voter', async () => {
    const { nodes, calls } = cluster({ [first]: [ACK()] });
    expect(nodes.order(VOTER, PID).map(n => n.getBaseUrl())).toEqual([first, second, third]);
    expect(await nodes.submitVote(vote())).toEqual({ voteId: VID, node: first });
    expect(calls).toEqual([`${first}/votes`]);
  });

  it('counts a 408 answered by 409 on the resend as accepted', async () => {
    const { nodes, calls } = cluster({
      [first]: [apiError(408, SequencerErrorCode.RequestTimeout), apiError(409, 40901)],
    });
    expect(await nodes.submitVote(vote())).toEqual({ voteId: VID, node: first });
    expect(calls).toHaveLength(2);
  });

  it('resends once to the same node after no answer, then moves on', async () => {
    const retried = cluster({ [first]: ['down', ACK()] });
    expect((await retried.nodes.submitVote(vote())).node).toBe(first);

    const moved = cluster({
      [first]: ['down', new Response('bad gateway', { status: 502 })],
      [second]: [ACK()],
    });
    expect((await moved.nodes.submitVote(vote())).node).toBe(second);
    expect(moved.calls).toEqual([`${first}/votes`, `${first}/votes`, `${second}/votes`]);

    // The first node may have taken it and the second synced it already.
    const synced = cluster({
      [first]: ['down', 'down'],
      [second]: [apiError(409, SequencerErrorCode.DuplicateVote)],
    });
    expect((await synced.nodes.submitVote(vote())).node).toBe(second);
  });

  it('skips a node that does not serve the process or is an observer', async () => {
    const { nodes, calls } = cluster({
      [first]: [apiError(404, SequencerErrorCode.UnknownProcess)],
      [second]: [apiError(412, SequencerErrorCode.ObserverNode)],
      [third]: [ACK()],
    });
    expect((await nodes.submitVote(vote())).node).toBe(third);
    expect(calls).toHaveLength(3);
  });

  it('never moves a voter to another node on a busy slot or a refusal', async () => {
    for (const code of [
      SequencerErrorCode.SlotBusy,
      SequencerErrorCode.Busy,
      SequencerErrorCode.InvalidVote,
      SequencerErrorCode.NotAcceptingVotes,
      SequencerErrorCode.DuplicateVote,
    ]) {
      const status = Math.floor(code / 100);
      const { nodes, calls } = cluster({ [first]: [apiError(status, code)] });
      await expect(nodes.submitVote(vote())).rejects.toMatchObject({ code });
      expect(calls, String(code)).toHaveLength(1);
    }
  });

  it('throws the last error when no node takes the vote', async () => {
    const { nodes, calls } = cluster({
      [first]: ['down', 'down'],
      [second]: [apiError(404, SequencerErrorCode.UnknownProcess)],
      [third]: ['down', 'down'],
    });
    await expect(nodes.submitVote(vote())).rejects.toBeInstanceOf(SequencerNetworkError);
    expect(calls).toHaveLength(5);
  });

  it("queues a revote on the node that holds the voter's previous ballot", async () => {
    // The first vote failed over to the second node.
    const failover = cluster({ [first]: ['down', 'down'], [second]: [ACK()] });
    const { node } = await failover.nodes.submitVote(vote());
    expect(node).toBe(second);

    // The first node is back; the revote still goes to the second.
    const revote = cluster({ [second]: [ACK()] });
    expect(await revote.nodes.submitVote(vote(), node)).toEqual({ voteId: VID, node: second });
    expect(revote.calls).toEqual([`${second}/votes`]);

    // If that node is gone, the voter's usual order follows it.
    const gone = cluster({ [second]: ['down', 'down'], [first]: [ACK()] });
    expect((await gone.nodes.submitVote(vote(), second)).node).toBe(first);
    expect(gone.calls.map(c => new URL(c).origin)).toEqual([second, second, first]);

    await expect(revote.nodes.submitVote(vote(), 'https://unknown.test')).rejects.toThrow(
      'unknown sequencer node'
    );
  });

  it('asks the node that took the vote for its status first', async () => {
    const { nodes, calls } = cluster({
      [second]: [apiError(404, SequencerErrorCode.NotFound)],
      [first]: [json({ status: 'pending' })],
    });
    expect(await nodes.getVoteStatus(PID, VID, second)).toEqual({
      status: 'pending',
      node: first,
    });
    expect(calls.map(c => new URL(c).origin)).toEqual([second, first]);
    expect(() => nodes.node('https://unknown.test')).toThrow('unknown sequencer node');
  });

  it('reads from the first node that answers, but not past a malformed request', async () => {
    const proof = {
      processId: PID,
      voteId: '0x8000000000000abc',
      root: `0x${'0c'.repeat(32)}`,
      siblings: [],
    };
    const { nodes } = cluster({
      [URLS[0]]: [apiError(404, SequencerErrorCode.NotFound)],
      [URLS[1]]: [json(proof)],
    });
    expect((await nodes.getVoteIdProof(PID, VID)).root).toBe(proof.root);

    const malformed = cluster({ [URLS[0]]: [apiError(400, SequencerErrorCode.MalformedRequest)] });
    await expect(malformed.nodes.getVoteIdProof(PID, VID)).rejects.toBeInstanceOf(
      SequencerApiError
    );
    expect(malformed.calls).toHaveLength(1);
  });

  it('drops duplicate URLs and needs at least one', () => {
    expect(new SequencerNodes(['https://a.test', 'https://a.test']).urls).toEqual([
      'https://a.test',
    ]);
    expect(() => new SequencerNodes([])).toThrow('at least one sequencer URL');
  });
});
