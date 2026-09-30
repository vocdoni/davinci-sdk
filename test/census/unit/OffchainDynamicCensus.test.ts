import { CensusOrigin, OffchainCensus, OffchainDynamicCensus } from '../../../src/census';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

describe('OffchainDynamicCensus', () => {
  it('is an updatable Merkle census that must be published', () => {
    const census = new OffchainDynamicCensus();
    expect(census.censusOrigin).toBe(CensusOrigin.OffchainDynamic);
    expect(census.requiresPublishing).toBe(true);
    expect(census.isPublished).toBe(false);
  });

  it('has the root of a static census with the same members', async () => {
    const dynamic = new OffchainDynamicCensus();
    const fixed = new OffchainCensus();
    for (const c of [dynamic, fixed]) c.add([A, { key: B, weight: 3 }]);
    expect(await dynamic.root()).toBe(await fixed.root());
    expect(dynamic.serialize()).toEqual(fixed.serialize());
  });

  it('reads its file back as an updatable census', () => {
    const census = new OffchainDynamicCensus();
    census.add([A, B]);
    const again = OffchainDynamicCensus.fromJSON(census.serialize());
    expect(again).toBeInstanceOf(OffchainDynamicCensus);
    expect(again.censusOrigin).toBe(CensusOrigin.OffchainDynamic);
    expect(again.participants).toEqual(census.participants);
  });

  it('needs a new publication once a member is added, reweighted or removed', async () => {
    const census = new OffchainDynamicCensus();
    census.add([A, B]);
    census._setPublishedData(await census.root(), 'https://files.example.org/c1.json');
    for (const change of [
      () => census.add('0x3333333333333333333333333333333333333333'),
      () => census.add({ key: A, weight: 2 }),
      () => census.remove(B),
    ]) {
      census._setPublishedData(await census.root(), 'https://files.example.org/c.json');
      change();
      expect(census.isPublished).toBe(false);
      expect([census.censusRoot, census.censusURI]).toEqual([null, null]);
    }
  });
});
