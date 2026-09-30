import { describe, expect, it, vi } from 'vitest';
import { serialized } from '../../../src/core/process/signerLock';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

describe('serialized', () => {
  it('shares its locks with every copy of the SDK loaded in the realm', async () => {
    // A second, separately evaluated copy of the module, as a CommonJS and an
    // ESM build of the SDK in one app would be.
    vi.resetModules();
    const copy = await import('../../../src/core/process/signerLock');
    expect(copy.serialized).not.toBe(serialized);
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for('davinci-sdk.signerLock')]
    ).toBeInstanceOf(Map);

    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>(resolve => (open = resolve));
    async function* first() {
      order.push('first:start');
      await gate;
      order.push('first:end');
      yield 1;
    }
    async function* second() {
      order.push('second:start');
      await Promise.resolve();
      yield 2;
    }
    const a = serialized('registry:account', first);
    const b = copy.serialized('registry:account', second);
    const nextA = a.next();
    await tick();
    const nextB = b.next();
    await tick();
    expect(order).toEqual(['first:start']);
    open();
    expect((await nextA).value).toBe(1);
    expect((await nextB).value).toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    // Other keys never wait.
    const other = copy.serialized('registry:other', second);
    expect((await other.next()).value).toBe(2);
  });

  it('passes the source failure to the consumer and frees the lock', async () => {
    // eslint-disable-next-line require-yield
    async function* failing(): AsyncGenerator<number> {
      await tick();
      throw new Error('boom');
    }
    async function* after() {
      await Promise.resolve();
      yield 3;
    }
    await expect(serialized('k', failing).next()).rejects.toThrow('boom');
    expect((await serialized('k', after).next()).value).toBe(3);
  });
});
