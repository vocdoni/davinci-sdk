/**
 * @fileoverview The conformance run's connection: the organizer's SDK and account,
 * the node client, and the organizer's transactions. Several test files may run
 * at once in separate processes, so every organizer transaction holds a lock
 * directory in the evidence directory (one nonce stream), and checks the run's
 * hard stops first: the process cap and the gas budget.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Wallet, formatEther, sha256 } from 'ethers';
import { DavinciSDK } from '../../../src/DavinciSDK';
import type { Census } from '../../../src/census/classes/Census';
import { ProcessStatus, type GraceParams } from '../../../src/contracts/types';
import type { TxStatusEvent } from '../../../src/contracts/SmartContractService';
import type { BallotMode } from '../../../src/core/types/common';
import type { ProcessConfig, ProcessCreationResult } from '../../../src/core/process';
import { FailoverRpcProvider, OPTIMISM } from '../../../src/networks';
import { BallotProver } from '../../../src/prover/BallotProver';
import { DirArtifactCache } from '../artifactCache';
import { Organizer } from '../organizer';
import { Evidence } from './evidence';
import { NodeClient } from './node';
import type { Settings } from './settings';
import { Throttle } from './throttle';

export const sleep = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms));

/** Thrown to stop a scenario at once (a hard limit, or the node failing). */
export class Fatal extends Error {}

/**
 * Metadata documents already served at a pushed commit of this repository: nodes
 * never read metadata, and the SDK reads it back by hash.
 */
const FIXTURES_COMMIT = 'ce486ba0fb3ad7dd23789350f3fd08a505a10318';
export function fixtureMetadata(name: string): { metadataUri: string; metadataHash: string } {
  const bytes = readFileSync(resolve(__dirname, '../fixtures', name));
  return {
    metadataUri: `https://raw.githubusercontent.com/vocdoni/davinci-sdk/${FIXTURES_COMMIT}/test/e2e/fixtures/${name}`,
    metadataHash: sha256(bytes),
  };
}

function readKey(path: string): string {
  const text = readFileSync(path, 'utf8').trim();
  const key = text.startsWith('0x') ? text : `0x${text}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} does not hold a hex private key`);
  return key;
}

/** One transaction stream at a time across processes: a lock directory. */
async function withFileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, 'organizer.lock');
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        // A lock older than 10 minutes was left by a crashed run.
        if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true });
      } catch {
        // Gone meanwhile.
      }
      await sleep(500);
    }
  }
  try {
    writeFileSync(join(lock, 'owner'), String(process.pid));
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

class LockedOrganizer extends Organizer {
  constructor(
    private readonly dir: string,
    private readonly guard: () => Promise<void>
  ) {
    super();
  }

  override exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return super.exclusive(() =>
      withFileLock(this.dir, async () => {
        await this.guard();
        return fn();
      })
    );
  }
}

/** A created process. */
export interface Election {
  label: string;
  processId: string;
  startTime: number;
  creationBlock: number;
  origin: string;
  mode: BallotMode;
}

export class Live {
  readonly ev: Evidence;
  readonly node: NodeClient;
  readonly throttle: Throttle;
  readonly org: LockedOrganizer;
  sdk!: DavinciSDK;
  wallet!: Wallet;
  grace!: GraceParams;
  readonly elections: Election[] = [];

  constructor(
    readonly settings: Settings,
    scenario: string
  ) {
    this.ev = new Evidence(settings.dir, scenario);
    this.throttle = Throttle.install(settings.node, settings.rps, settings.dir);
    this.node = new NodeClient(settings.node, this.ev);
    this.org = new LockedOrganizer(settings.dir, () => this.budgetGuard());
  }

  private async budgetGuard(): Promise<void> {
    const balance = await this.sdk.provider.getBalance(this.wallet.address);
    const spent = this.settings.budgetBaseWei - balance;
    if (spent >= this.settings.budgetWei) {
      throw new Fatal(`gas budget reached: spent ${formatEther(spent)} ETH`);
    }
  }

  async connect(): Promise<void> {
    const provider = new FailoverRpcProvider(this.settings.rpcUrls, OPTIMISM.chainId);
    this.wallet = new Wallet(readKey(this.settings.organizerKeyFile), provider);
    this.sdk = new DavinciSDK({
      signer: this.wallet,
      network: 'optimism',
      sequencerUrls: [this.settings.node],
      rpcUrls: this.settings.rpcUrls,
      artifacts: { cache: new DirArtifactCache(this.settings.artifactsDir) },
    });
    await this.sdk.init();
    const unusable = this.sdk.nodeChecks.filter(c => c.status !== 'usable');
    if (unusable.length > 0) throw new Fatal(`the node is not usable: ${unusable[0].status}`);
    this.grace = await this.sdk.getGraceParams();
    const balance = await provider.getBalance(this.wallet.address);
    this.ev.log('connect', {
      organizer: this.wallet.address,
      balance: formatEther(balance),
      grace: this.grace,
    });
    this.ev.say(`organizer ${this.wallet.address}: ${formatEther(balance)} ETH`);
    await this.pingOrStop('connect');
  }

  /** GET /ping between phases; a failure stops the scenario. */
  async pingOrStop(phase: string): Promise<void> {
    const ok = await this.node.ping();
    this.ev.log('ping', { phase, ok });
    if (!ok) throw new Fatal(`GET /ping failed at ${phase}`);
    const fives = this.node.problems.filter(p => p.what === '5xx').length;
    if (fives >= 3) throw new Fatal(`${fives} 5xx answers so far: stopping`);
  }

  /** Runs an organizer transaction stream, recorded. */
  send<T>(label: string, stream: () => AsyncGenerator<TxStatusEvent<T>>): Promise<T> {
    return this.org.send(label, stream).then(
      r => {
        this.ev.log('tx', { label, last: this.org.sent[this.org.sent.length - 1] });
        return r;
      },
      (err: unknown) => {
        this.ev.log('tx-failed', {
          label,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    );
  }

  /**
   * Creates a sequencer-key process with the grace window at the floor. Refused
   * locally once the organizer has created `maxProcesses`.
   */
  async createProcess(
    label: string,
    p: {
      census: Census;
      ballot: BallotMode;
      maxVoters: number;
      duration: number;
      /** Seconds from the chain head at the creation's turn. */
      startIn?: number;
      metadata: string;
      origin: string;
    }
  ): Promise<Election> {
    const sdk = this.sdk;
    const max = this.settings.maxProcesses;
    const address = this.wallet.address;
    const stream = async function* () {
      const nonce = Number(await sdk.registry.getProcessNonce(address));
      if (nonce >= max) throw new Fatal(`the organizer already created ${nonce} processes`);
      const now = Number(await sdk.registry.getChainTime());
      const config: ProcessConfig = {
        ...fixtureMetadata(p.metadata),
        census: p.census,
        ballot: p.ballot,
        maxVoters: p.maxVoters,
        timing:
          p.startIn === undefined
            ? { duration: p.duration }
            : { startDate: now + p.startIn, duration: p.duration },
        keyMode: 'sequencer',
      };
      yield* sdk.createProcessStream(config);
    };
    const created: ProcessCreationResult = await this.org.sendWithKey(`${label} create`, stream);
    const onchain = await this.waitReadable(created.processId);
    const e: Election = {
      label,
      processId: created.processId,
      startTime: Number(onchain.startTime),
      creationBlock: Number(onchain.creationBlock),
      origin: p.origin,
      mode: p.ballot,
    };
    this.elections.push(e);
    const line = {
      label,
      processId: e.processId,
      tx: created.transactionHash,
      origin: p.origin,
      mode: p.ballot,
      maxVoters: p.maxVoters,
      startTime: e.startTime,
      duration: p.duration,
    };
    appendFileSync(join(this.settings.dir, 'processes.jsonl'), `${JSON.stringify(line)}\n`);
    this.ev.log('process-created', line);
    this.ev.say(`${label}: created ${e.processId} (block ${e.creationBlock})`);
    // The grace window at the floor, so the results follow the close within minutes.
    await this.send(`${label} setProcessGrace`, () =>
      sdk.setProcessGraceStream(e.processId, this.grace.graceFloor)
    );
    return e;
  }

  private async waitReadable(pid: string) {
    for (let i = 0; i < 60; i++) {
      const p = await this.sdk.registry.getProcess(pid).catch(() => undefined);
      if (p && p.creationBlock > 0n) return p;
      await sleep(2000);
    }
    throw new Error(`${pid} not readable after 120 s`);
  }

  /** Waits until the node serves the process (fails at once if it ignores it). */
  async waitServed(e: Election, timeoutMs = 5 * 60_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await this.node.process(e.processId);
      if (view?.ignored) throw new Error(`the node ignores ${e.processId}: ${String(view.note)}`);
      if (view) return view;
      if (Date.now() > deadline) throw new Error(`the node does not serve ${e.processId}`);
      await sleep(4000);
    }
  }

  async chainTime(): Promise<number> {
    return Number(await this.sdk.registry.getChainTime());
  }

  async endOf(e: Election): Promise<number> {
    const p = await this.sdk.registry.getProcess(e.processId);
    return Number(p.startTime + p.duration);
  }

  /** Closes `noticeMin` (plus the SDK's slack) from now; returns the new end. */
  async closeSoon(e: Election): Promise<number> {
    await this.send(`${e.label} closeProcessIn`, () =>
      this.sdk.closeProcessInStream(e.processId, this.grace.noticeMin)
    );
    const end = await this.endOf(e);
    this.ev.say(`${e.label}: closes at ${new Date(end * 1000).toISOString()}`);
    return end;
  }

  /** Waits for RESULTS (or CANCELED); returns the registry's process. */
  async waitFinal(e: Election, timeoutMs = 30 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = await this.sdk.registry.getProcess(e.processId).catch(() => undefined);
      if (p && (p.status === ProcessStatus.RESULTS || p.status === ProcessStatus.CANCELED))
        return p;
      if (Date.now() > deadline)
        throw new Error(`${e.label}: no results after ${timeoutMs / 1000} s`);
      await sleep(10_000);
    }
  }

  /** Cancels the processes this instance created that are still open. */
  async cancelOpen(): Promise<void> {
    for (const e of this.elections) {
      try {
        const p = await this.sdk.registry.getProcess(e.processId);
        if (p.status !== ProcessStatus.READY && p.status !== ProcessStatus.PAUSED) continue;
        const graceEnd = Number(await this.sdk.registry.getProcessGraceEnd(e.processId));
        if (graceEnd !== 0 && (await this.chainTime()) >= graceEnd - 30) {
          this.ev.say(`${e.label}: open past its grace end, left to its results`);
          continue;
        }
        await this.send(`${e.label} cancel (cleanup)`, () =>
          this.sdk.cancelProcessStream(e.processId)
        );
        this.ev.say(`${e.label}: canceled in cleanup`);
      } catch (err) {
        this.ev.say(
          `${e.label}: cleanup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  async close(): Promise<void> {
    this.ev.log('organizer-txs', { sent: this.org.sent });
    this.ev.log('node-requests', {
      requests: this.throttle.requests,
      problems: this.node.problems,
      serverErrors: this.throttle.serverErrors,
    });
    await BallotProver.terminate();
  }
}

/**
 * Keeps an election's end between 110 and 175 s ahead while running, so the
 * node stays in flush mode (`--flush-horizon`, 3 min by default) and every
 * pending vote seals as soon as no batch is in flight, while admission stays
 * open. Never past `startTime + maxSeconds`. `stop()` lets it end on its own.
 */
export class RollingEnd {
  private running = false;
  private loop?: Promise<void>;
  extensions = 0;

  constructor(
    private readonly live: Live,
    private readonly e: Election,
    private readonly maxSeconds = 38 * 60
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        try {
          await this.tick();
        } catch (err) {
          this.live.ev.say(
            `${this.e.label}: rolling end tick failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        await sleep(8_000);
      }
    })();
  }

  private async tick(): Promise<void> {
    const [now, end] = await Promise.all([this.live.chainTime(), this.live.endOf(this.e)]);
    if (end - now >= 110) return;
    const cap = this.e.startTime + this.maxSeconds;
    const target = Math.min(now + 175, cap);
    if (target <= end + 5 || end <= now + 15) {
      if (end <= now + 15) this.running = false;
      return;
    }
    await this.live.send(`${this.e.label} extend`, () =>
      this.live.sdk.extendProcessStream(this.e.processId, target - end)
    );
    this.extensions++;
    this.live.ev.log('extend', { processId: this.e.processId, from: end, to: target });
  }

  /** Stops extending; the election ends at its current end (under 3 minutes away). */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
