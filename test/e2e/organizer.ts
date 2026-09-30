/**
 * @fileoverview The organizer account's transactions, one at a time. The
 * scenarios run concurrently but share one account, and the SDK serializes
 * only process creations per account: two other transactions sent at once
 * would race for a nonce. Every transaction goes through {@link Organizer}
 * in turn, and each one sent is recorded for the gas bill.
 */

import { formatEther, formatUnits, type Provider } from 'ethers';
import { TxStatus, type TxStatusEvent } from '../../src/contracts/SmartContractService';

/** A transaction the organizer sent. */
export interface SentTx {
  label: string;
  hash: string;
}

/** One line of the gas bill. */
export interface BillLine extends SentTx {
  gasUsed: bigint;
  gasPrice: bigint;
  /** Wei. */
  cost: bigint;
  ok: boolean;
}

/** Sequencer-key creations per minute, under the key node's 10 per minute per IP. */
export const KEY_REQUESTS_PER_MINUTE = 8;

const sleep = (ms: number) => new Promise<void>(ok => setTimeout(ok, ms));

/** Time for the key request window. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class Organizer {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly keyRequests: number[] = [];
  readonly sent: SentTx[] = [];

  /**
   * @param clock - The key request window's clock (tests pass their own)
   */
  constructor(private readonly clock: Clock = { now: () => Date.now(), sleep }) {}

  /** Runs `fn` after every earlier organizer job has finished. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Records a transaction sent outside a stream (a contract deployment). */
  record(label: string, hash: string): void {
    this.sent.push({ label, hash });
  }

  /**
   * Runs a transaction stream in turn and returns its result: every
   * `pending` event is recorded, a `failed` or `reverted` one throws.
   */
  send<T>(label: string, stream: () => AsyncGenerator<TxStatusEvent<T>>): Promise<T> {
    return this.exclusive(async () => {
      let done: { response: T } | undefined;
      for await (const event of stream()) {
        switch (event.status) {
          case TxStatus.Pending:
            this.record(event.step ? `${label} (${event.step})` : label, event.hash);
            break;
          case TxStatus.Completed:
            done = { response: event.response };
            break;
          case TxStatus.Failed:
            throw event.error;
          case TxStatus.Reverted:
            throw event.error ?? new Error(`${label} reverted: ${event.reason ?? 'no reason'}`);
        }
      }
      if (!done) throw new Error(`${label}: the stream ended without a result`);
      return done.response;
    });
  }

  /**
   * {@link send} for a creation that asks the key node for a key: waits
   * while {@link KEY_REQUESTS_PER_MINUTE} were asked in the last minute.
   */
  sendWithKey<T>(label: string, stream: () => AsyncGenerator<TxStatusEvent<T>>): Promise<T> {
    return this.send(label, () => this.keyed(stream));
  }

  // The stream, once the key request window has room.
  private async *keyed<T>(
    stream: () => AsyncGenerator<TxStatusEvent<T>>
  ): AsyncGenerator<TxStatusEvent<T>> {
    for (;;) {
      const since = this.clock.now() - 60_000;
      while (this.keyRequests.length > 0 && this.keyRequests[0] <= since) this.keyRequests.shift();
      if (this.keyRequests.length < KEY_REQUESTS_PER_MINUTE) break;
      await this.clock.sleep(this.keyRequests[0] - since + 100);
    }
    this.keyRequests.push(this.clock.now());
    yield* stream();
  }

  /** The receipts of every transaction sent: gas, price and cost. */
  async bill(provider: Provider): Promise<BillLine[]> {
    return Promise.all(
      this.sent.map(async tx => {
        const r = await provider.getTransactionReceipt(tx.hash);
        if (!r) return { ...tx, gasUsed: 0n, gasPrice: 0n, cost: 0n, ok: false };
        return {
          ...tx,
          gasUsed: r.gasUsed,
          gasPrice: r.gasPrice,
          cost: r.gasUsed * r.gasPrice + (r.blobGasUsed ?? 0n) * (r.blobGasPrice ?? 0n),
          ok: r.status === 1,
        };
      })
    );
  }
}

/** The bill as text: one line per transaction and the total, in xDAI. */
export function formatBill(lines: readonly BillLine[]): string {
  const total = lines.reduce((sum, l) => sum + l.cost, 0n);
  const width = Math.max(10, ...lines.map(l => l.label.length));
  const rows = lines.map(
    l =>
      `  ${l.label.padEnd(width)}  gas ${String(l.gasUsed).padStart(9)} @ ` +
      `${formatUnits(l.gasPrice, 'gwei').padStart(12)} gwei  ${formatEther(l.cost)} xDAI` +
      `${l.ok ? '' : '  (no receipt or reverted)'}  ${l.hash}`
  );
  return [`organizer: ${lines.length} transactions, ${formatEther(total)} xDAI`, ...rows].join(
    '\n'
  );
}
