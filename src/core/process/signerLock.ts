/**
 * @fileoverview Serializes process creation per account. Between reading the
 * id the registry assigns next and mining `newProcess`, another creation from
 * the same account would take that id, and a sequencer key issued for it
 * would belong to the wrong process. The lock covers one JS realm: separate
 * processes or workers signing for one account are not serialized.
 */

// One map per JS realm, shared by every copy of the SDK loaded in it (the
// CommonJS and ESM builds, or two versions): the lock holds across them.
const LOCKS = Symbol.for('davinci-sdk.signerLock');
const holder = globalThis as typeof globalThis & { [LOCKS]?: Map<string, Promise<void>> };
const tails = (holder[LOCKS] ??= new Map<string, Promise<void>>());

// Waits for the lock of `key`; resolves with its release.
async function acquire(key: string): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => (release = resolve));
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  return () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

/**
 * Runs the stream `source` under the lock of `key` and yields its events.
 * The lock is taken when the first event is asked for and held until `source`
 * ends, which it runs to the end whether or not the consumer keeps reading:
 * a transaction already sent is waited for before the next creation reads
 * its id.
 */
export async function* serialized<T>(
  key: string,
  source: () => AsyncGenerator<T>
): AsyncGenerator<T> {
  const release = await acquire(key);
  const run: {
    events: T[];
    finished: boolean;
    failure?: { error: unknown };
    wake?: () => void;
  } = { events: [], finished: false };
  void (async () => {
    try {
      for await (const event of source()) {
        run.events.push(event);
        run.wake?.();
      }
    } catch (error) {
      run.failure = { error };
    } finally {
      run.finished = true;
      release();
      run.wake?.();
    }
  })();
  while (!run.finished || run.events.length > 0) {
    if (run.events.length > 0) {
      yield run.events.shift() as T;
      continue;
    }
    await new Promise<void>(resolve => (run.wake = resolve));
    run.wake = undefined;
  }
  if (run.failure) throw run.failure.error;
}
