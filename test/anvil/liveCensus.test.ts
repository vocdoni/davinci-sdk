import { getAddress } from 'ethers';
import { describe, expect, it } from 'vitest';
import { OnchainCensus } from '../../src/census/classes/OnchainCensus';
import { OnchainCensusService } from '../../src/contracts/OnchainCensusService';
import { SmartContractService } from '../../src/contracts/SmartContractService';
import {
  CENSUS_CONTRACT_COMMIT,
  POSEIDON_T3_ADDRESS,
  deployOwnedCensus,
  isPoseidonT3,
  linkOwnedCensus,
  withoutMetadata,
} from '../e2e/census';
import censusSource from '../../src/contracts/abi/census/source.json';
import vendored from '../e2e/contracts/census.json';
import {
  addresses,
  anvil,
  chainProvider,
  deployOwnedCensus as deployAnvilCensus,
  devWallet,
  rpc,
} from './harness';

// The live suite deploys OwnedCensus on Gnosis from creation code vendored
// with `yarn sync:abis --census`; this checks it against this suite's own
// build of the same commit, and runs its deployment both ways.
const ACCOUNT = 9;

// Where the anvil build links PoseidonT3, read from its linked creation code.
function anvilPoseidon(): string {
  const refs = Object.values(vendored.contracts.OwnedCensus.linkReferences)[0].PoseidonT3;
  const at = 2 + refs[0].start * 2;
  return getAddress(`0x${anvil().ownedCensusBytecode.slice(at, at + 40)}`);
}

describe("the live suite's census contract", () => {
  it('is vendored from the commit of the census ABIs', () => {
    expect(CENSUS_CONTRACT_COMMIT).toBe(censusSource.commit);
  });

  it('is the creation code this suite builds, metadata aside', async () => {
    const library = anvilPoseidon();
    expect(withoutMetadata(linkOwnedCensus(library))).toBe(
      withoutMetadata(anvil().ownedCensusBytecode)
    );
    expect(isPoseidonT3(await chainProvider().getCode(library))).toBe(true);
    expect(isPoseidonT3('0x')).toBe(false);
    expect(isPoseidonT3(await chainProvider().getCode(anvil().registry))).toBe(false);
  });

  it('deploys PoseidonT3 when none is at its usual address, then a working census', async () => {
    const provider = chainProvider();
    expect(await provider.getCode(POSEIDON_T3_ADDRESS)).toBe('0x');
    const sent: string[] = [];
    const deployed = await deployOwnedCensus(devWallet(ACCOUNT, provider), (label, hash) =>
      sent.push(`${label} ${hash}`)
    );
    expect(deployed.deployedLibrary).toBe(true);
    expect(sent.map(s => s.split(' 0x')[0])).toEqual(['deploy PoseidonT3', 'deploy OwnedCensus']);
    expect(isPoseidonT3(await provider.getCode(deployed.poseidonT3))).toBe(true);
    const census = new OnchainCensusService(deployed.address, devWallet(ACCOUNT, provider));
    await SmartContractService.executeTx(census.addMembers(addresses(2), [2, 3]));
    expect((await new OnchainCensus(deployed.address).check(provider)).size).toBe(2);
  });

  it('links the PoseidonT3 at its usual address when it is there', async () => {
    const provider = chainProvider();
    const code = await provider.getCode(anvilPoseidon());
    // The library's runtime code carries its own address after the PUSH20.
    const there = `0x73${POSEIDON_T3_ADDRESS.slice(2).toLowerCase()}${code.slice(44)}`;
    await rpc('anvil_setCode', [POSEIDON_T3_ADDRESS, there]);
    try {
      const members = addresses(2);
      const sent: string[] = [];
      const deployed = await deployOwnedCensus(devWallet(ACCOUNT, provider), label =>
        sent.push(label)
      );
      expect(deployed).toMatchObject({ poseidonT3: POSEIDON_T3_ADDRESS, deployedLibrary: false });
      expect(sent).toEqual(['deploy OwnedCensus']);
      const census = new OnchainCensusService(deployed.address, devWallet(ACCOUNT, provider));
      await SmartContractService.executeTx(census.addMembers(members, [1, 1]));

      // The same members in a census of the anvil build: the same root.
      const built = await deployAnvilCensus(devWallet(ACCOUNT, provider));
      const other = new OnchainCensusService(built, devWallet(ACCOUNT, provider));
      await SmartContractService.executeTx(other.addMembers(members, [1, 1]));
      expect(await census.getCensusRoot()).toBe(await other.getCensusRoot());
    } finally {
      await rpc('anvil_setCode', [POSEIDON_T3_ADDRESS, '0x']);
    }
  });
});
