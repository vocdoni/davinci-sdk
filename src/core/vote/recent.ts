/**
 * @fileoverview A map bounded to its most recently written entries.
 */

/** Keeps the `capacity` most recently written entries; older ones are dropped. */
export class RecentMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity ${capacity} is not a positive integer`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  /** Writes `key` as the newest entry, dropping the oldest past the capacity. */
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}
