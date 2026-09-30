#!/usr/bin/env node
// Builds llms.txt (the index of docs/ai, as raw GitHub links) and
// llms-full.txt (docs/ai concatenated) from the manifest below, so both
// follow the docs. It fails when a file under docs/ai is missing from the
// manifest (or listed but gone), and `--check` fails when either output is
// out of date.
//
// Usage: node scripts/build-llms.mjs [--check]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = 'https://raw.githubusercontent.com/vocdoni/davinci-sdk/main';
const RULE = '='.repeat(64);

// Every file of docs/ai, in reading order, with the line llms.txt gives it.
const ENTRY = {
  file: 'docs/ai/SKILL.md',
  section: 'Entry point (SKILL.md)',
  about:
    'start here. What DAVINCI is, the package shape, the mental model, a short end-to-end example and a table from task to reference.',
};

const REFERENCES = [
  [
    'setup',
    'Setup',
    'install, configuration, networks and node URLs, `init()`, the read provider, the uploader and the circuit files.',
  ],
  [
    'process',
    'Process lifecycle',
    '`createProcess` and its config, timing, `maxVoters`, the organizer controls and their windows, `getProcess`.',
  ],
  [
    'key-modes',
    'Key modes',
    'sequencer, `dkg` and `dkg-locked` election keys, the organizer secret and `revealProcessKey`.',
  ],
  [
    'grace',
    'Grace window',
    'the grace window after the end, the phases, `closeProcessIn`, the grace floor and running a live meeting.',
  ],
  [
    'census',
    'Census',
    'the four census origins: local Merkle censuses and publishing them, updates, the on-chain census contract, CSP attestations.',
  ],
  [
    'metadata',
    'Metadata',
    'the metadata document, its exact bytes and on-chain hash, publishing, verification on read, updates.',
  ],
  [
    'voting',
    'Voting',
    '`submitVote`, the `choices` model, statuses and their timing, vote errors, eligibility reads.',
  ],
  [
    'nodes',
    'Sequencer nodes',
    'several nodes: node checks at init, per-voter routing, failover and the revote-on-the-same-node rule.',
  ],
  [
    'receipts',
    'Receipts',
    'vote receipts: tracker proofs checked against the registry state roots.',
  ],
  [
    'results',
    'Results',
    'when results come for each key mode, `waitForResults`, the results states and decoding tallies.',
  ],
  [
    'ballot-modes',
    'Ballot modes',
    'presets and raw ballot modes: single and multiple choice, approval, rating, ranking, quadratic, budget.',
  ],
  [
    'sequencer',
    'Sequencer REST client',
    'the node HTTP API client, its routes, wire types and error codes.',
  ],
  [
    'contracts',
    'Contracts',
    '`ProcessRegistryService`, transaction status streams, events, revert decoding, deployment pins.',
  ],
  [
    'errors',
    'Errors',
    'the error classes, sequencer codes, registry revert names and what to do about each.',
  ],
  [
    'protocol',
    'Protocol',
    'how DAVINCI works: the zkVM batches, the ballot, slots and silent revoting, the grace window, results.',
  ],
].map(([name, section, about]) => ({ file: `docs/ai/references/${name}.md`, section, about }));

const RECIPES = [
  ['bootstrap', 'configure the SDK, `init()` and report what it found.'],
  ['create-process', 'create an election with a local census, streaming the transaction.'],
  ['cast-vote', 'vote as a voter and follow the vote to `settled`.'],
  ['full-election', 'an election end to end: census, creation, votes, early close, results.'],
  ['read-results', "wait for a process's results and print them."],
  ['onchain-census', 'an election on an append-only census contract.'],
  ['dkg-locked', 'a committee key locked by the organizer, and the reveal.'],
  ['close-early', 'close a running election with notice and the grace at the floor.'],
  ['receipt', 'a vote receipt checked against the registry.'],
].map(([name, about]) => ({ file: `docs/ai/recipes/${name}.ts`, name: `${name}.ts`, about }));

// Every file under docs/ai must be in the manifest, and nothing else.
const listed = [ENTRY, ...REFERENCES, ...RECIPES].map(f => f.file).sort();
const present = [
  ...readdirSync(join(root, 'docs/ai')).map(f => `docs/ai/${f}`),
  ...readdirSync(join(root, 'docs/ai/references')).map(f => `docs/ai/references/${f}`),
  ...readdirSync(join(root, 'docs/ai/recipes')).map(f => `docs/ai/recipes/${f}`),
]
  .filter(f => !['docs/ai/references', 'docs/ai/recipes'].includes(f))
  .sort();
const unlisted = present.filter(f => !listed.includes(f));
const missing = listed.filter(f => !present.includes(f));
if (unlisted.length || missing.length) {
  if (unlisted.length) console.error(`not in the manifest: ${unlisted.join(', ')}`);
  if (missing.length) console.error(`in the manifest but not in docs/ai: ${missing.join(', ')}`);
  console.error('update the manifest in scripts/build-llms.mjs');
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const read = file => readFileSync(join(root, file), 'utf8').trimEnd();
const link = ({ file, about }) => `- [${file.split('/').pop()}](${RAW}/${file}) — ${about}`;

const index = `# Vocdoni DaVinci SDK — documentation index

TypeScript SDK for the Vocdoni DAVINCI voting protocol: private, verifiable
elections on an Ethereum registry, with ballots proved in the voter's browser
or process and batched by sequencer nodes into zkVM proofs. Covers imports of
\`@vocdoni/davinci-sdk\`: the \`DavinciSDK\` facade, censuses, ballot modes, key
modes, the grace window, results, receipts and the node and contract layers.

## Entry point

${link(ENTRY)}

## Topic references

${REFERENCES.map(link).join('\n')}

## Recipes (runnable TypeScript)

${RECIPES.map(link).join('\n')}

## Bundles

- [llms-full.txt](${RAW}/llms-full.txt) — everything above in one file.

## Source

Built from \`docs/ai/\` by \`scripts/build-llms.mjs\`. The SDK is at
https://github.com/vocdoni/davinci-sdk (AGPL-3.0).
`;

const section = (title, body) => `${RULE}\n# Section: ${title}\n${RULE}\n\n${body}\n`;

const full = `# Vocdoni DaVinci SDK — full documentation bundle

This file concatenates \`docs/ai/SKILL.md\`, \`docs/ai/references/*.md\` and
\`docs/ai/recipes/*.ts\` of the davinci-sdk repository, for the SDK at
v${version}. It is generated by \`scripts/build-llms.mjs\`; edit the sources.
The SDK is at https://github.com/vocdoni/davinci-sdk (AGPL-3.0).

For the index, see ${RAW}/llms.txt.

${[
  section(ENTRY.section, read(ENTRY.file)),
  ...REFERENCES.map(r => section(r.section, read(r.file))),
  section(
    'Recipes',
    RECIPES.map(r => `## Recipe: ${r.name}\n\n\`\`\`typescript\n${read(r.file)}\n\`\`\``).join(
      '\n\n'
    )
  ),
].join('\n')}`;

const outputs = [
  ['llms.txt', index],
  ['llms-full.txt', full],
];

if (process.argv.includes('--check')) {
  const stale = outputs.filter(([file, text]) => {
    try {
      return readFileSync(join(root, file), 'utf8') !== text;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(
      `${stale.map(([f]) => f).join(' and ')} out of date: run node scripts/build-llms.mjs`
    );
    process.exit(1);
  }
  console.log('llms.txt and llms-full.txt are up to date');
} else {
  for (const [file, text] of outputs) writeFileSync(join(root, file), text);
  console.log('wrote llms.txt and llms-full.txt');
}
