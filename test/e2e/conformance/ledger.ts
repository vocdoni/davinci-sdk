/**
 * @fileoverview What a process's node accepted and refused, and the checks of a
 * finished process against it: every accepted vote reaches its expected status
 * (`settled` unless the test says otherwise) moving forward, its receipt
 * verifies, a refused vote id never appears, and the registry's tally and
 * counters equal the ones computed from the accepted votes (per slot, the last
 * one admitted that settled), as do the node's view and its transitions.
 */

import { ProcessStatus } from '../../../src/contracts/types';
import type { Draft } from './ballots';
import type { Answer } from './node';
import { sleep, type Election, type Live } from './live';

export interface Sent {
  label: string;
  voteId: string;
  slot: string;
  choices: bigint[];
  weight: bigint;
  status: number;
  code?: number;
  error?: string;
  accepted: boolean;
  /** Admission order among the accepted. */
  seq: number;
  sentAt: number;
  statuses: string[];
  last?: string;
  lastError?: string;
  /** The final status the test expects; `settled` by default. */
  expectFinal: 'settled' | 'error';
}

const FINAL = new Set(['settled', 'error']);
const RANK: Record<string, number> = { pending: 0, aggregated: 1, processed: 2, settled: 3 };

export interface Expectation {
  status: number;
  code?: number;
}

export class Ledger {
  readonly sent: Sent[] = [];
  private seq = 0;
  private following = false;
  private loop?: Promise<void>;

  constructor(
    readonly live: Live,
    readonly e: Election
  ) {}

  get accepted(): Sent[] {
    return this.sent.filter(s => s.accepted);
  }

  /** Records an answer to a submission of `d` (sent elsewhere, e.g. in a burst). */
  record(
    d: Pick<Draft, 'label' | 'voteId' | 'slot' | 'choices' | 'weight'>,
    a: Pick<Answer, 'status' | 'code' | 'error' | 'ms'>,
    label = d.label
  ): Sent {
    const accepted = a.status === 200;
    const s: Sent = {
      label,
      voteId: d.voteId,
      slot: d.slot,
      choices: d.choices,
      weight: d.weight,
      status: a.status,
      code: a.code,
      error: a.error,
      accepted,
      seq: accepted ? this.seq++ : -1,
      sentAt: Date.now(),
      statuses: [],
      expectFinal: 'settled',
    };
    this.sent.push(s);
    this.live.ev.log('vote', {
      processId: this.e.processId,
      label,
      voteId: d.voteId,
      slot: d.slot,
      choices: d.choices,
      weight: d.weight,
      status: a.status,
      code: a.code,
      error: a.error,
      ms: a.ms,
    });
    this.live.ev.say(
      `${label}: ${a.status}${a.code ? ` ${a.code}` : ''}${a.error ? ` ${a.error.slice(0, 120)}` : ''} (${d.voteId})`
    );
    return s;
  }

  /**
   * POSTs `d` (or `body` in its place) and records the answer; with `expect`,
   * checks the status and code.
   */
  async submit(
    d: Draft,
    opts: {
      label?: string;
      body?: string | object;
      headers?: Record<string, string>;
      expect?: Expectation;
    } = {}
  ): Promise<Sent> {
    const a = await this.live.node.post('/votes', opts.body ?? d.body, opts.headers);
    const s = this.record(d, a, opts.label ?? d.label);
    if (opts.expect) {
      const got: Expectation = {
        status: a.status,
        ...(opts.expect.code !== undefined && { code: a.code }),
      };
      const want: Expectation = {
        status: opts.expect.status,
        ...(opts.expect.code !== undefined && { code: opts.expect.code }),
      };
      this.live.ev.eq(`${this.e.label}: ${s.label}`, got, want, { error: a.error });
    }
    return s;
  }

  private async poll(s: Sent): Promise<void> {
    const a = await this.live.node.voteStatus(this.e.processId, s.voteId);
    if (a.status !== 200) {
      s.lastError = `GET status ${a.status} ${a.code ?? ''}`;
      return;
    }
    const v = a.json as { status: string; error?: string };
    if (s.statuses[s.statuses.length - 1] !== v.status) {
      s.statuses.push(v.status);
      this.live.ev.log('vote-status', {
        processId: this.e.processId,
        label: s.label,
        voteId: s.voteId,
        status: v.status,
        error: v.error,
      });
    }
    s.last = v.status;
    if (v.error) s.lastError = v.error;
  }

  /** Polls the accepted votes still open, one request every `everyMs`, until {@link stopFollowing}. */
  follow(everyMs = 2500): void {
    if (this.following) return;
    this.following = true;
    this.loop = (async () => {
      let i = 0;
      while (this.following) {
        const open = this.accepted.filter(s => !FINAL.has(s.last ?? ''));
        if (open.length > 0) {
          const s = open[i++ % open.length];
          try {
            await this.poll(s);
          } catch {
            // Retried on its next turn.
          }
        }
        await sleep(everyMs);
      }
    })();
  }

  async stopFollowing(): Promise<void> {
    this.following = false;
    await this.loop;
  }

  /** Waits until `s` reaches one of `statuses`; returns the one it reached, or undefined. */
  async waitFor(
    s: Sent,
    statuses: string[],
    timeoutMs: number,
    everyMs = 2500
  ): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.poll(s).catch(() => undefined);
      if (s.last && statuses.includes(s.last)) return s.last;
      if (s.last && FINAL.has(s.last)) return s.last;
      if (Date.now() > deadline) return undefined;
      await sleep(everyMs);
    }
  }

  /** Waits until every accepted vote is settled or errored. */
  async waitAllFinal(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const open = this.accepted.filter(s => !FINAL.has(s.last ?? ''));
      if (open.length === 0) return true;
      for (const s of open) await this.poll(s).catch(() => undefined);
      if (Date.now() > deadline) return false;
      await sleep(5000);
    }
  }

  /** The tally, voters and overwrites the accepted, settled votes give. */
  expected(numFields: number): { tally: bigint[]; voters: number; overwrites: number } {
    const bySlot = new Map<string, Sent>();
    let settled = 0;
    for (const s of [...this.accepted].sort((a, b) => a.seq - b.seq)) {
      if (s.last !== 'settled') continue;
      settled++;
      bySlot.set(s.slot, s);
    }
    const tally = Array.from({ length: numFields }, () => 0n);
    for (const s of bySlot.values()) s.choices.forEach((c, i) => (tally[i] += c));
    return { tally, voters: bySlot.size, overwrites: settled - bySlot.size };
  }
}

/**
 * The checks of a finished process (RESULTS or CANCELED) against what its node
 * accepted and refused.
 */
export async function finalChecks(
  live: Live,
  ledger: Ledger,
  opts: { canceled?: boolean } = {}
): Promise<void> {
  const { ev, sdk, node } = live;
  const e = ledger.e;
  const pid = e.processId;
  const name = (s: string) => `${e.label}: ${s}`;

  await ledger.stopFollowing();
  const allFinal = await ledger.waitAllFinal(5 * 60_000);
  ev.check(name('every accepted vote reached settled or error'), allFinal, {
    open: ledger.accepted.filter(s => !FINAL.has(s.last ?? '')).map(s => [s.label, s.last]),
  });

  for (const s of ledger.accepted) {
    ev.eq(name(`${s.label} (${s.voteId}) final status`), s.last, s.expectFinal, {
      error: s.lastError,
      statuses: s.statuses,
    });
    const ranks = s.statuses.filter(x => x !== 'error').map(x => RANK[x] ?? -1);
    const forward = ranks.every((r, i) => i === 0 || r === 0 || r > ranks[i - 1]);
    ev.check(name(`${s.label} statuses move forward`), forward, { statuses: s.statuses });
    if (s.last === 'settled') {
      try {
        const r = await sdk.getVoteReceipt(pid, s.voteId);
        ev.check(name(`${s.label} receipt verifies`), r.voteId === s.voteId, {
          root: r.root,
          latest: r.latest,
          tx: r.transactionHash,
        });
      } catch (err) {
        ev.check(name(`${s.label} receipt verifies`), false, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // A refused vote id the node never took must never appear.
  const acceptedIds = new Set(ledger.accepted.map(s => s.voteId));
  const refused = [...new Set(ledger.sent.filter(s => !s.accepted).map(s => s.voteId))].filter(
    v => !acceptedIds.has(v)
  );
  for (const vid of refused) {
    const st = await node.voteStatus(pid, vid);
    const pr = await node.get(`/votes/${pid}/voteId/${vid}/proof`);
    ev.eq(name(`refused ${vid} never appears`), [st.code, pr.code], [40401, 40401], {
      labels: ledger.sent.filter(s => s.voteId === vid).map(s => s.label),
    });
  }

  const p = await sdk.registry.getProcess(pid);
  const view = await node.process(pid);
  const nf = p.ballotMode.numFields;
  const want = ledger.expected(nf);
  ev.log('final', {
    processId: pid,
    status: ProcessStatus[p.status],
    result: p.result,
    votersCount: p.votersCount,
    overwrittenVotesCount: p.overwrittenVotesCount,
    expected: want,
    nodeView: view,
  });
  if (opts.canceled) {
    ev.eq(name('registry status'), ProcessStatus[p.status], 'CANCELED');
  } else {
    ev.eq(name('registry status'), ProcessStatus[p.status], 'RESULTS');
    ev.eq(name('on-chain tally equals the accepted votes'), p.result.slice(0, nf), want.tally);
    ev.eq(name('node result equals the registry'), view?.result, p.result.map(Number));
  }
  ev.eq(name('on-chain votersCount'), Number(p.votersCount), want.voters);
  ev.eq(name('on-chain overwrittenVotesCount'), Number(p.overwrittenVotesCount), want.overwrites);
  ev.eq(
    name('node view counters and root equal the registry'),
    [view?.votersCount, view?.overwrittenVotesCount, view?.stateRoot, view?.synced],
    [Number(p.votersCount), Number(p.overwrittenVotesCount), p.latestStateRoot, true]
  );

  // The node's transitions are the chain's.
  const tr = await node.get(`/processes/${pid}/transitions`);
  const list = ((tr.json as { transitions?: Record<string, unknown>[] } | undefined)?.transitions ??
    []) as {
    index: number;
    oldRoot: string;
    newRoot: string;
    txHash: string;
    blockNumber: number;
    voters: number;
    overwrites: number;
  }[];
  const events: {
    tx: string;
    newRoot: string;
    voters: bigint;
    overwrites: bigint;
    at: number;
  }[] = [];
  for await (const window of sdk.registry.eventWindows({
    processId: pid,
    fromBlock: e.creationBlock,
  })) {
    for (const ev2 of window) {
      if (ev2.name === 'ProcessStateTransitioned') {
        events.push({
          tx: ev2.transactionHash.toLowerCase(),
          newRoot: ev2.newStateRoot.toLowerCase(),
          voters: ev2.votersCount,
          overwrites: ev2.overwrittenVotesCount,
          at: ev2.blockNumber * 1e5 + ev2.logIndex,
        });
      }
    }
  }
  const sorted = [...events].sort((a, b) => a.at - b.at);
  ev.eq(
    name('node transitions equal the chain events (tx, new root)'),
    list.map(t => [t.txHash.toLowerCase(), t.newRoot.toLowerCase()]),
    sorted.map(x => [x.tx, x.newRoot])
  );
  let voters = 0;
  let overwrites = 0;
  const running = list.map(t => {
    voters += t.voters - t.overwrites;
    overwrites += t.overwrites;
    return [voters, overwrites];
  });
  ev.eq(
    name('per-transition counts add up to the chain counters'),
    running,
    sorted.map(x => [Number(x.voters), Number(x.overwrites)])
  );
  ev.log('transitions', { processId: pid, list, events });
}
