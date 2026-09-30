/**
 * An election whose census is an append-only census contract (origin 3):
 * `OwnedCensus` of davinci-onchain-census-contract, branch davinci-zkvm.
 *
 *   1. connect the organizer
 *   2. use CENSUS_CONTRACT, or deploy an OwnedCensus owned by the organizer
 *      (its creation code is the one `yarn sync:abis --census` vendors)
 *   3. add weighted members, and check the contract is a census nodes accept
 *   4. create a process on it: each member's weight is its budget
 *   5. members vote, spreading their weight; a member added while voting
 *      runs votes too
 *   6. close with notice and wait for the results
 *
 * Nodes index the members from the contract's logs, and voters' weights are
 * read from the contract: only the metadata document needs hosting.
 */

import {
  BallotProver,
  OnchainCensus,
  OnchainCensusService,
  OWNED_CENSUS_ABI,
  SmartContractService,
  type DavinciSDK,
} from '@vocdoni/davinci-sdk';
import { ContractFactory, Wallet, getAddress, type Signer } from 'ethers';
import creationCode from '../../../test/e2e/contracts/census.json';
import { connect, info, organizerSigner, step, uploader, voteWhenReady } from './config';

const OPTIONS = ['Grants', 'Audits', 'Reserve'];

// poseidon-solidity deploys PoseidonT3 at this address on chains that have it.
const POSEIDON_T3 = '0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93';

// Deploys an OwnedCensus linked to PoseidonT3 (the deterministic copy, else a new one).
async function deployOwnedCensus(signer: Signer): Promise<string> {
  const code = creationCode.contracts;
  let library = POSEIDON_T3;
  if ((await signer.provider!.getCode(library)) === '0x') {
    const poseidon = await new ContractFactory([], code.PoseidonT3.bytecode, signer).deploy();
    library = await (await poseidon.waitForDeployment()).getAddress();
    info('PoseidonT3 deployed at', library);
  }
  let bytecode = code.OwnedCensus.bytecode.slice(2);
  const libraryHex = getAddress(library).slice(2).toLowerCase();
  for (const byName of Object.values(code.OwnedCensus.linkReferences)) {
    for (const refs of Object.values(byName)) {
      for (const { start, length } of refs) {
        bytecode = bytecode.slice(0, start * 2) + libraryHex + bytecode.slice((start + length) * 2);
      }
    }
  }
  const census = await new ContractFactory(OWNED_CENSUS_ABI, `0x${bytecode}`, signer).deploy();
  return (await census.waitForDeployment()).getAddress();
}

async function vote(sdk: DavinciSDK, processId: string, spread: bigint[]) {
  const v = await voteWhenReady(sdk, { processId, choices: spread });
  info(`${v.voterAddress} (weight ${v.weight}) spreads ${spread.join('/')}: ${v.voteId}`);
  return v;
}

async function main() {
  step(1, 'Connect the organizer');
  const signer = organizerSigner();
  const organizer = await connect(signer, { uploader: uploader() });
  const { noticeMin, graceFloor } = await organizer.getGraceParams();

  step(2, 'The census contract');
  const address = process.env.CENSUS_CONTRACT?.trim() || (await deployOwnedCensus(signer));
  info('OwnedCensus at', address);
  const owned = new OnchainCensusService(address, signer);

  step(3, 'Members');
  const members = [10n, 25n, 40n].map(weight => ({ wallet: Wallet.createRandom(), weight }));
  await SmartContractService.executeTx(
    owned.addMembers(
      members.map(m => m.wallet.address),
      members.map(m => m.weight)
    )
  );
  const census = new OnchainCensus(address);
  const { size } = await census.check(organizer.provider);
  info(`${size} members, total weight ${await owned.totalVotingPower()}`);

  step(4, 'Create the process');
  const { processId } = await organizer.createProcess({
    title: `Treasury allocation, ${new Date().toISOString()}`,
    census,
    maxVoters: 100, // required: the contract may grow while the process runs
    ballot: {
      numFields: OPTIONS.length,
      minValue: '0',
      maxValue: '100', // the largest weight a member can put on one option
      uniqueValues: false,
      costExponent: 1,
      minValueSum: '0',
      maxValueSum: '0', // each voter's census weight is its budget
    },
    timing: { duration: 3600 },
    grace: graceFloor,
    questions: [
      {
        title: 'Where should the funds go?',
        choices: OPTIONS.map((title, value) => ({ title, value })),
      },
    ],
  });
  info('process', processId);

  step(5, 'Vote');
  const cast: { sdk: DavinciSDK; voteId: string }[] = [];
  for (const [i, m] of members.entries()) {
    const sdk = await connect(m.wallet);
    const spread = [0n, 0n, 0n];
    spread[i % OPTIONS.length] = m.weight; // the whole weight on one option
    cast.push({ sdk, voteId: (await vote(sdk, processId, spread)).voteId });
  }
  // The registry takes every root the contract records from the process's creation on.
  const late = Wallet.createRandom();
  await SmartContractService.executeTx(owned.addMember(late.address, 6n));
  const lateSdk = await connect(late);
  cast.push({ sdk: lateSdk, voteId: (await vote(lateSdk, processId, [2n, 2n, 2n])).voteId });

  step(6, `Close in ${noticeMin} s, follow the votes and wait for the results`);
  await organizer.closeProcessIn(processId, noticeMin);
  for (const { sdk, voteId } of cast) {
    const final = await sdk.waitForVoteStatus(processId, voteId);
    info(voteId, final.status, final.error ?? '');
  }
  const results = await organizer.waitForResults(processId, {
    onStatus: s => info(new Date().toISOString(), s.state),
  });
  for (const c of results.questions[0].choices) info(`${c.title}: ${c.total}`);
}

main()
  .then(() => BallotProver.terminate())
  .then(
    () => process.exit(0),
    err => {
      console.error(err);
      process.exit(1);
    }
  );
