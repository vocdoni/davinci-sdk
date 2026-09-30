/**
 * @fileoverview The steps every election of the run goes through: create it
 * (grace at the floor), wait until the nodes serve it, vote, close it with
 * notice, follow the votes to their end, check receipts, and wait for the
 * results while recording the states the SDK reports.
 */

import type { BaseWallet } from 'ethers';
import { expect } from 'vitest';
import type { DavinciSDK } from '../../../src/DavinciSDK';
import type { CensusProviders } from '../../../src/census/types';
import { ProcessStatus, KeyMode } from '../../../src/contracts/types';
import type { ProcessConfig, ProcessCreationResult } from '../../../src/core/process';
import { VoteError } from '../../../src/core/vote/errors';
import type { ProcessResults, ResultsState } from '../../../src/core/vote/results';
import type { VoteConfig, VoteResult } from '../../../src/core/vote';
import { VoteStatus } from '../../../src/sequencer/api/types';
import { say } from '../env';
import { metadataOf, type ElectionSpec } from '../spec';
import type { Live } from './context';

export const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));

/** An error that ends an {@link until} wait at once instead of being retried. */
export class Fatal extends Error {}

/** A process lasts this long unless closed early: nodes flush only near the end. */
export const DURATION = 3600;

/**
 * Polls `ready` every `everyMs` until it answers true.
 *
 * @throws naming `what` after `timeoutMs`, with the last error `ready` threw
 */
export async function until(
  what: string,
  ready: () => Promise<boolean>,
  timeoutMs: number,
  everyMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      if (await ready()) return;
    } catch (err) {
      if (err instanceof Fatal) throw err;
      last = err;
    }
    if (Date.now() >= deadline) {
      const why = last instanceof Error ? `: ${last.message}` : '';
      throw new Error(`${what}: not after ${Math.round(timeoutMs / 1000)} s${why}`);
    }
    await sleep(everyMs);
  }
}

/** A created election. */
export interface Election extends ProcessCreationResult {
  label: string;
  /** Block of the creation. */
  block: number;
}

/**
 * Creates an election from `spec` with the grace window at the floor, an
 * hour long unless `config` says otherwise, through the organizer's queue.
 * `timing`, when given, is called when the creation's turn comes: a start
 * time must still be ahead of the chain head then.
 */
export async function createElection(
  live: Live,
  label: string,
  spec: ElectionSpec,
  config: Partial<ProcessConfig>,
  timing?: () => Promise<ProcessConfig['timing']>
): Promise<Election> {
  async function* stream() {
    yield* live.sdk.createProcessStream({
      ...metadataOf(spec),
      ...(spec.ballot ? { ballot: spec.ballot } : {}),
      timing: timing ? await timing() : { duration: DURATION },
      grace: live.grace.graceFloor,
      ...config,
    } as ProcessConfig);
  }
  const keyed = (config.keyMode ?? 'sequencer') === 'sequencer';
  const created = keyed
    ? await live.org.sendWithKey(`${label} create`, stream)
    : await live.org.send(`${label} create`, stream);
  expect(created.graceError, `${label}: grace`).toBeUndefined();
  const receipt = await live.sdk.provider.getTransactionReceipt(created.transactionHash);
  say(`${label}: created ${created.processId} in block ${receipt?.blockNumber ?? '?'}`);
  return { ...created, label, block: receipt?.blockNumber ?? 0 };
}

/**
 * Waits until every node serves the process (a node that refuses it fails
 * at once, with its note) and, when `members` are given, answers each one's
 * census proof, at `root` when given.
 */
export async function waitServed(
  live: Live,
  e: Election,
  members: readonly string[] = [],
  root?: bigint,
  timeoutMs = 10 * 60_000
): Promise<void> {
  const nodes = live.sdk.api.nodes.nodes;
  await until(
    `${e.label}: every node serving ${e.processId}${members.length ? ` and ${members.length} members` : ''}`,
    async () => {
      for (const node of nodes) {
        const view = await node.getProcess(e.processId);
        if (view.ignored) {
          throw new Fatal(`${node.getBaseUrl()} ignores ${e.processId}: ${view.note ?? 'no note'}`);
        }
        for (const m of members) {
          const p = await node.getParticipant(e.processId, m);
          if (root !== undefined && p.censusProof.root !== root) return false;
        }
      }
      return true;
    },
    timeoutMs
  );
}

/**
 * One SDK per voter, initialized on first use and kept for its revotes (the
 * SDK remembers the node that took a voter's ballot).
 */
export function voterSdks(
  live: Live,
  wallets: readonly BaseWallet[],
  censusProviders?: CensusProviders
): (i: number) => Promise<DavinciSDK> {
  const sdks = new Map<number, Promise<DavinciSDK>>();
  return i => {
    let sdk = sdks.get(i);
    if (!sdk) sdks.set(i, (sdk = live.voterSdk(wallets[i], censusProviders)));
    return sdk;
  };
}

/** A vote the run follows. */
export interface Cast extends VoteResult {
  label: string;
}

/**
 * Casts a vote, retrying for a while when the nodes are busy or not ready
 * (still loading a new census, or not serving a new process yet).
 */
export async function vote(
  sdk: DavinciSDK,
  label: string,
  config: VoteConfig,
  patienceMs = 5 * 60_000
): Promise<Cast> {
  const deadline = Date.now() + patienceMs;
  for (;;) {
    try {
      const r = await sdk.submitVote(config);
      say(`${label}: vote ${r.voteId} to ${r.node}`);
      return { ...r, label };
    } catch (err) {
      const retry =
        err instanceof VoteError && (err.reason === 'busy' || err.reason === 'unavailable');
      if (!retry || Date.now() >= deadline) throw err;
      say(`${label}: ${err.reason}, retrying: ${err.message.slice(0, 160)}`);
      await sleep(10_000);
    }
  }
}

/** Closes the election `noticeMin` from now (plus the SDK's inclusion slack). */
export async function closeSoon(live: Live, e: Election): Promise<Date> {
  await live.org.send(`${e.label} closeProcessIn`, () =>
    live.sdk.closeProcessInStream(e.processId, live.grace.noticeMin)
  );
  const p = await live.sdk.getProcess(e.processId);
  say(`${e.label}: closes at ${p.endDate.toISOString()}`);
  return p.endDate;
}

const RANK: Record<VoteStatus, number> = {
  [VoteStatus.Error]: -1,
  [VoteStatus.Pending]: 0,
  [VoteStatus.Aggregated]: 1,
  [VoteStatus.Processed]: 2,
  [VoteStatus.Settled]: 3,
};

/** The statuses a vote went through, as the node that took it reported them. */
export interface Followed {
  cast: Cast;
  statuses: VoteStatus[];
  error?: string;
}

/**
 * Follows each vote until it settles or fails. The statuses must move
 * forward, except back to `pending` when a batch lost a race.
 */
export async function follow(live: Live, e: Election, casts: readonly Cast[]): Promise<Followed[]> {
  return Promise.all(
    casts.map(async cast => {
      const statuses: VoteStatus[] = [];
      let error: string | undefined;
      for await (const s of live.sdk.watchVoteStatus(e.processId, cast.voteId, {
        node: cast.node,
      })) {
        statuses.push(s.status);
        error = s.error;
      }
      const last = statuses[statuses.length - 1];
      say(`${e.label}: ${cast.label} ${statuses.join(' > ')}${error ? ` (${error})` : ''}`);
      if (last !== VoteStatus.Error) {
        const ranks = statuses.map(s => RANK[s]);
        ranks.forEach((r, i) => {
          if (i > 0 && r !== 0)
            expect(r, `${cast.label}: ${statuses.join(' > ')}`).toBeGreaterThan(ranks[i - 1]);
        });
      }
      return { cast, statuses, error };
    })
  );
}

/** Every settled vote's receipt verifies against a state root of the process. */
export async function checkReceipts(
  live: Live,
  e: Election,
  casts: readonly Cast[]
): Promise<void> {
  for (const cast of casts) {
    const r = await live.sdk.getVoteReceipt(e.processId, cast.voteId, cast.node);
    expect(r.voteId).toBe(cast.voteId);
    expect(r.latest || r.transactionHash !== undefined, `${cast.label}: receipt root`).toBe(true);
  }
  say(`${e.label}: ${casts.length} receipts verified`);
}

/** The results wait, started early so it sees every state. */
export interface ResultsWatch {
  states: ResultsState[];
  done: Promise<ProcessResults>;
}

/** Starts waiting for the results, recording each state the SDK reports. */
export function watchResults(live: Live, e: Election): ResultsWatch {
  const states: ResultsState[] = [];
  const done = live.sdk.waitForResults(e.processId, {
    pollIntervalMs: 10_000,
    onStatus: s => {
      states.push(s.state);
      say(`${e.label}: ${s.state}${s.graceEnd ? ` (grace ends ${s.graceEnd.toISOString()})` : ''}`);
    },
  });
  // Awaited by the scenario; this keeps an early rejection from going unhandled.
  done.catch(() => undefined);
  return { states, done };
}

/** The order results states can come in, per key mode. */
const ORDER: ResultsState[] = [
  'voting',
  'grace',
  'awaiting-key-holder',
  'awaiting-request',
  'locked',
  'decrypting',
  'finalizable',
  'results',
];

/**
 * Checks the results: the tally, the voters, the status, the states seen
 * (in order, through the grace window) and that the results landed only
 * once the grace window had closed.
 */
export async function checkResults(
  live: Live,
  e: Election,
  results: ProcessResults,
  states: readonly ResultsState[],
  want: { tally: bigint[]; voters: number; overwrites?: number }
): Promise<void> {
  // One total per ballot field; fields past the stored ones count zero.
  const totals = want.tally.map((_, i) => results.values[i] ?? 0n);
  expect(totals, `${e.label}: tally`).toEqual(want.tally);
  expect(results.values.length).toBeLessThanOrEqual(want.tally.length);
  expect(results.voters, `${e.label}: voters`).toBe(want.voters);
  const info = await live.sdk.getProcess(e.processId);
  expect(info.status).toBe(ProcessStatus.RESULTS);
  expect(info.phase).toBe('results');
  expect(info.votersCount).toBe(want.voters);
  expect(info.overwrittenVotesCount).toBe(want.overwrites ?? 0);

  expect(states, `${e.label}: states`).toContain('grace');
  expect(states[states.length - 1]).toBe('results');
  const at = states.map(s => ORDER.indexOf(s));
  expect(at, `${e.label}: states in order: ${states.join(' > ')}`).toEqual(
    [...at].sort((a, b) => a - b)
  );
  if (info.keyMode === KeyMode.Sequencer) {
    expect(
      states.filter(s => ['awaiting-request', 'locked', 'decrypting', 'finalizable'].includes(s))
    ).toEqual([]);
  }

  // The grace end the SDK computes is the registry's, and the results
  // transaction landed at or after it.
  const graceEnd = info.graceEnd;
  expect(graceEnd).not.toBeNull();
  expect(await live.sdk.getGraceEnd(e.processId), `${e.label}: grace end`).toEqual(graceEnd);
  let landed: number | undefined;
  for await (const events of live.sdk.registry.eventWindows({
    processId: e.processId,
    fromBlock: e.block,
  })) {
    const set = events.find(ev => ev.name === 'ProcessResultsSet');
    if (set) {
      landed = (await live.sdk.provider.getBlock(set.blockNumber))?.timestamp;
      break;
    }
  }
  expect(landed, `${e.label}: ProcessResultsSet`).toBeDefined();
  expect((landed as number) * 1000).toBeGreaterThanOrEqual((graceEnd as Date).getTime());
  say(
    `${e.label}: results ${results.values.slice(0, 4).join(',')}… from ${want.voters} voters; ` +
      `grace ended ${(graceEnd as Date).toISOString()}, results at ${new Date((landed as number) * 1000).toISOString()}`
  );
}
