import { describe, expect, it } from 'vitest';
import { OnchainCensus } from '../../src/census/classes/OnchainCensus';
import { OnchainCensusService } from '../../src/contracts/OnchainCensusService';
import { SmartContractService } from '../../src/contracts/SmartContractService';
import { BN254_FR } from '../../src/crypto/field';
import { LeanIMT, censusLeaf } from '../../src/crypto/census';
import {
  CENSUS_CONTRACT_COMMIT,
  OWNED_CENSUS_BYTECODE,
  deployOwnedCensus,
  isOwnedCensus,
  withoutMetadata,
} from '../e2e/census';
import censusSource from '../../src/contracts/abi/census/source.json';
import vendored from '../e2e/contracts/census.json';
import { anvil, chainProvider, deployOwnedCensus as deployAnvilCensus, devWallet } from './harness';

// The live suite deploys OwnedCensus on OP Mainnet from creation code vendored
// with `yarn sync:abis --census`; this checks it against this suite's own
// build of the same commit, and runs its deployment.
const ACCOUNT = 9;
// Fixed members whose Keccak root is above the BN254 modulus.
const MEMBERS = ['11', '22', '33'].map(b => `0x${b.repeat(20)}`);
const WEIGHTS = [2n, 3n, 5n];

describe("the live suite's census contract", () => {
  it('is vendored from the commit of the census ABIs', () => {
    expect(CENSUS_CONTRACT_COMMIT).toBe(censusSource.commit);
  });

  it('is the creation code this suite builds, metadata aside, and links no library', () => {
    expect(Object.keys(vendored.contracts)).toEqual(['OwnedCensus']);
    expect(vendored.contracts.OwnedCensus).not.toHaveProperty('linkReferences');
    expect(withoutMetadata(OWNED_CENSUS_BYTECODE)).toBe(
      withoutMetadata(anvil().ownedCensusBytecode)
    );
  });

  it('deploys one contract, whose Keccak roots are the SDK tree', async () => {
    const provider = chainProvider();
    const sent: string[] = [];
    const deployed = await deployOwnedCensus(devWallet(ACCOUNT, provider), (label, hash) =>
      sent.push(`${label} ${hash}`)
    );
    expect(sent.map(s => s.split(' 0x')[0])).toEqual(['deploy OwnedCensus']);
    expect(isOwnedCensus(await provider.getCode(deployed.address))).toBe(true);
    expect(isOwnedCensus(await provider.getCode(anvil().registry))).toBe(false);

    const census = new OnchainCensusService(deployed.address, devWallet(ACCOUNT, provider));
    await SmartContractService.executeTx(census.addMembers(MEMBERS, WEIGHTS));
    expect((await new OnchainCensus(deployed.address).check(provider)).size).toBe(3);
    const tree = new LeanIMT(MEMBERS.map((m, i) => censusLeaf(m, WEIGHTS[i])));
    expect(tree.root >= BN254_FR).toBe(true);
    expect(await census.getCensusRoot()).toBe(tree.root);

    // The same members in a census of the anvil build: the same root.
    const built = await deployAnvilCensus(devWallet(ACCOUNT, provider));
    const other = new OnchainCensusService(built, devWallet(ACCOUNT, provider));
    await SmartContractService.executeTx(other.addMembers(MEMBERS, WEIGHTS));
    expect(await other.getCensusRoot()).toBe(tree.root);
  });
});
