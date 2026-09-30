/**
 * recipes/onchain-census.ts
 *
 * An election whose census is an append-only census contract (origin 3):
 * davinci-onchain-census-contract, branch davinci-zkvm. `OwnedCensus` is its
 * owner-managed version; deploy one with Foundry from that repository (it
 * links the PoseidonT3 library), owned by PRIVATE_KEY's account.
 *
 *   - add members with their weights (fixed once added)
 *   - check the contract is a census the nodes accept
 *   - create a process on it: maxVoters is required, and the ballot makes each
 *     member's weight its budget (maxValueSum 0)
 *   - add a member while voting runs: it can vote too
 *
 * Nodes index the members from the contract's logs; voters' weights are read
 * from the contract. Only the metadata document needs hosting.
 *
 * Environment: DAVINCI_NODES, RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL,
 *              CENSUS_CONTRACT (the OwnedCensus address)
 *
 * Usage:
 *   tsx onchain-census.ts 0xVoter1:10,0xVoter2:25
 */

import {
  DavinciSDK,
  OnchainCensus,
  OnchainCensusService,
  SmartContractService,
  type Uploader,
} from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const { RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL, CENSUS_CONTRACT } = process.env as Record<
  string,
  string
>;
const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const members = (process.argv[2] ?? '')
  .split(',')
  .filter(Boolean)
  .map(entry => {
    const [address, weight = '1'] = entry.split(':');
    return { address, weight: BigInt(weight) };
  });

const uploader: Uploader = {
  async upload({ data, contentType, sha256 }) {
    const name = `${sha256.slice(2)}.json`;
    const res = await fetch(`${UPLOAD_URL}/${name}`, {
      method: 'PUT',
      body: new Uint8Array(data), // a copy fetch types accept
      headers: { 'content-type': contentType },
    });
    if (!res.ok) throw new Error(`upload of ${name} failed: HTTP ${res.status}`);
    return `${PUBLIC_URL}/${name}`;
  },
};

async function main() {
  const organizer = new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL));
  const sdk = new DavinciSDK({ signer: organizer, sequencerUrls: nodes, uploader });
  await sdk.init();

  // 1. Members: one transaction for all. SlotTaken or AlreadyRegisteredAddress in revertName.
  const owned = new OnchainCensusService(CENSUS_CONTRACT, organizer);
  if (members.length > 0) {
    await SmartContractService.executeTx(
      owned.addMembers(
        members.map(m => m.address),
        members.map(m => m.weight)
      )
    );
  }

  // 2. The census object. createProcess runs this check too.
  const census = new OnchainCensus(CENSUS_CONTRACT);
  const { root, size } = await census.check(sdk.provider);
  console.log(`census ${CENSUS_CONTRACT}: ${size} members, root ${root}`);

  // 3. A weighted vote: each member spreads its weight over the options.
  const { processId } = await sdk.createProcess({
    title: 'Treasury allocation',
    census,
    maxVoters: 10_000, // required: the contract may grow
    ballot: {
      numFields: 3,
      minValue: '0',
      maxValue: '1000000', // the largest weight, to put it all on one option
      uniqueValues: false,
      costExponent: 1,
      minValueSum: '0',
      maxValueSum: '0', // 0: each voter's census weight is its budget
    },
    timing: { duration: 24 * 3600 },
    questions: [
      {
        title: 'Where should the funds go?',
        choices: [
          { title: 'Grants', value: 0 },
          { title: 'Audits', value: 1 },
          { title: 'Reserve', value: 2 },
        ],
      },
    ],
  });
  console.log('process', processId);

  // 4. A member added while the process runs can vote: the registry accepts
  //    every root the contract records from the process's creation on.
  const late = Wallet.createRandom();
  await SmartContractService.executeTx(owned.addMember(late.address, 5n));
  console.log('late member weight', await sdk.getAddressWeight(processId, late.address));

  // Voters then vote as in cast-vote.ts, e.g. a weight-25 member: choices [20, 5, 0].
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
