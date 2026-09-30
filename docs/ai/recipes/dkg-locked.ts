/**
 * recipes/dkg-locked.ts
 *
 * A committee-held key whose results stay locked until the organizer
 * releases them:
 *
 *   - createProcess with keyMode 'dkg-locked' returns the organizer secret,
 *     once: the SDK keeps no copy, and without it the results never unlock
 *   - after the end and the grace window the results read `locked`
 *   - revealProcessKey lets the committee decrypt the tally
 *
 * The registry must have a DKG adapter (the Gnosis one does). The secret is
 * written to SECRET_FILE with owner-only permissions; keep it with the
 * organizer's other credentials.
 *
 * Environment: DAVINCI_NODES, RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL, SECRET_FILE
 *
 * Usage:
 *   tsx dkg-locked.ts create 0xVoter1,0xVoter2   (prints the process id)
 *   tsx dkg-locked.ts reveal <processId>          (after the grace window)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { DavinciSDK, OffchainCensus, ResultsError, type Uploader } from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';

const { RPC_URL, PRIVATE_KEY, UPLOAD_URL, PUBLIC_URL, SECRET_FILE } = process.env as Record<
  string,
  string
>;
const nodes = (process.env.DAVINCI_NODES ?? '').split(',').filter(Boolean);
const [command, arg] = process.argv.slice(2);

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

async function create(sdk: DavinciSDK, voters: string[]) {
  const census = new OffchainCensus();
  census.add(voters);
  const { processId, organizerSecret } = await sdk.createProcess({
    title: 'Board election',
    census,
    electionPreset: { type: 'multiple_choice', maxSelections: 2 },
    timing: { duration: 2 * 3600 },
    keyMode: 'dkg-locked',
    questions: [
      {
        title: 'Elect two members',
        choices: [
          { title: 'Alice', value: 0 },
          { title: 'Bob', value: 1 },
          { title: 'Carol', value: 2 },
        ],
      },
    ],
  });
  if (organizerSecret === undefined) throw new Error('no organizer secret returned');
  // Store it before anything else can fail.
  writeFileSync(SECRET_FILE, `${processId} ${organizerSecret.toString()}\n`, { mode: 0o600 });
  console.log('process', processId, '- organizer secret stored in', SECRET_FILE);
}

async function reveal(sdk: DavinciSDK, processId: string) {
  const [storedId, secret] = readFileSync(SECRET_FILE, 'utf8').trim().split(' ');
  if (storedId !== processId) throw new Error(`${SECRET_FILE} holds the secret of ${storedId}`);

  const status = await sdk.getResultsStatus(processId);
  console.log('results state:', status.state); // 'locked' once the grace window has closed

  // Anyone holding the secret may reveal; a wrong one is refused (InvalidOrganizerSecret).
  await sdk.revealProcessKey(processId, BigInt(secret));

  try {
    const results = await sdk.waitForResults(processId, {
      onStatus: s => console.log('results state:', s.state), // decrypting, finalizable, results
    });
    for (const c of results.questions[0].choices) console.log(`${c.title}: ${c.total}`);
  } catch (err) {
    if (err instanceof ResultsError) console.error(err.reason, err.message);
    throw err;
  }
}

async function main() {
  const sdk = new DavinciSDK({
    signer: new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC_URL)),
    sequencerUrls: nodes,
    uploader,
  });
  await sdk.init();
  if (command === 'create') await create(sdk, (arg ?? '').split(',').filter(Boolean));
  else if (command === 'reveal' && arg) await reveal(sdk, arg);
  else throw new Error('usage: tsx dkg-locked.ts create <addresses> | reveal <processId>');
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
