import { CensusSlotCollisionError, OffchainCensus } from '../../../src/census';

// Real collisions cost about 2^63 / N key generations; this file maps two
// addresses to one slot, as the node's `leaves_of_with` test does.
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

vi.mock('../../../src/crypto/census', async importOriginal => {
  const real = await importOriginal<typeof import('../../../src/crypto/census')>();
  return {
    ...real,
    slotFromAddress: (address: string) =>
      address.toLowerCase() === '0x2222222222222222222222222222222222222222'
        ? real.slotFromAddress('0x1111111111111111111111111111111111111111')
        : real.slotFromAddress(address),
  };
});

describe('Merkle census slot collisions', () => {
  it('refuses a member whose slot another member holds, naming both', () => {
    const census = new OffchainCensus();
    census.add(A);
    let err: unknown;
    try {
      census.add({ key: B, weight: 2 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CensusSlotCollisionError);
    expect((err as CensusSlotCollisionError).addresses).toEqual([A, B]);
    expect((err as CensusSlotCollisionError).slot).toBe(census.slotOf(A));
    expect((err as Error).message).toMatch(/^ballot slot 0x[0-9a-f]+ is shared by 0x1111/);
    expect(census.addresses).toEqual([A]);
  });

  it('refuses a colliding pair within one batch and adds none of it', () => {
    const census = new OffchainCensus();
    expect(() => census.add([C, A, B])).toThrow(CensusSlotCollisionError);
    expect(census.size).toBe(0);
  });

  it('frees the slot when its member is removed', () => {
    const census = new OffchainCensus();
    census.add(A);
    census.remove(A);
    census.add(B);
    expect(census.addresses).toEqual([B]);
    expect(() => census.add(A)).toThrow(CensusSlotCollisionError);
  });

  it('refuses a census file with two members on one slot', () => {
    const file = { participants: [A, B].map(key => ({ key, weight: '1' })) };
    expect(() => OffchainCensus.fromJSON(file)).toThrow(CensusSlotCollisionError);
  });
});
