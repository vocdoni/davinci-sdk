import { ZeroHash, getAddress } from 'ethers';
import { CensusError, CensusOrigin, CensusWitnessError, OnchainCensus } from '../../../src/census';
import { CensusContractError, ONCHAIN_CENSUS_ABI } from '../../../src/contracts';
import { slotFromAddress } from '../../../src/crypto';
import { MockChain } from '../../helpers/mockChain';

const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
const MEMBER = '0x1111111111111111111111111111111111111111';

// A davinci-zkvm census contract with one member of weight 5.
function chainWith(slotOf = (a: string) => slotFromAddress(a)) {
  const chain = new MockChain();
  chain.contract(CONTRACT, ONCHAIN_CENSUS_ABI, {
    getCensusRoot: () => [123n],
    treeSize: () => [1n],
    slotOf: args => [slotOf(args[0] as string)],
    weightOf: args => [(args[0] as string).toLowerCase() === MEMBER ? 5n : 0n],
  });
  return chain;
}

describe('OnchainCensus', () => {
  it('points the registry at the contract, with root zero and an informational URI', () => {
    const census = new OnchainCensus(CONTRACT);
    expect(census.censusOrigin).toBe(CensusOrigin.Onchain);
    expect(census.requiresPublishing).toBe(false);
    expect(census.isPublished).toBe(true);
    expect(census.contractAddress).toBe(getAddress(CONTRACT));
    expect(census.censusRoot).toBe(ZeroHash);
    expect(census.censusURI).toBe(`onchain://${getAddress(CONTRACT)}`);
    expect(census.toRegistryCensus()).toEqual({
      origin: CensusOrigin.Onchain,
      root: ZeroHash,
      uri: `onchain://${getAddress(CONTRACT)}`,
      contractAddress: getAddress(CONTRACT),
    });
    expect(new OnchainCensus(CONTRACT, 'https://explorer.example/address/x').censusURI).toBe(
      'https://explorer.example/address/x'
    );
  });

  it('refuses a bad address or an empty URI', () => {
    expect(() => new OnchainCensus('0x1234')).toThrow(CensusError);
    expect(() => new OnchainCensus(CONTRACT, ' ')).toThrow('must not be empty');
  });

  it('checks the contract is a davinci-zkvm census', async () => {
    const census = new OnchainCensus(CONTRACT);
    expect(await census.check(chainWith())).toEqual({ root: 123n, size: 1 });

    const other = chainWith(() => 0x10n);
    await expect(census.check(other)).rejects.toThrow(/derives ballot slot 16, not \d+/);

    // The upstream census: no slotOf.
    const upstream = new MockChain();
    upstream.contract(
      CONTRACT,
      [
        'function getCensusRoot() view returns (uint256)',
        'function treeSize() view returns (uint256)',
      ],
      {
        getCensusRoot: () => [1n],
        treeSize: () => [0n],
      }
    );
    await expect(census.check(upstream)).rejects.toThrow('has no slotOf');

    const empty = new MockChain();
    await expect(census.check(empty)).rejects.toThrow(CensusContractError);
    await expect(census.check(empty)).rejects.toThrow(`no contract at ${getAddress(CONTRACT)}`);
  });

  it('gives a member its weight as witness and refuses a non-member', async () => {
    const census = new OnchainCensus(CONTRACT);
    expect(await census.witness(chainWith(), MEMBER)).toEqual({ type: 'merkle', weight: 5n });
    await expect(
      census.witness(chainWith(), '0x2222222222222222222222222222222222222222')
    ).rejects.toThrow(CensusWitnessError);
  });
});
