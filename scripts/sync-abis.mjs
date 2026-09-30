#!/usr/bin/env node
// Copies the contract ABIs the SDK uses from a forge checkout into
// src/contracts/abi/ and records the commit they came from in source.json.
//
//   node scripts/sync-abis.mjs <davinci-contracts checkout> [--out <forge out dir>]
//   node scripts/sync-abis.mjs --census <davinci-onchain-census-contract checkout> [--out <dir>]
//
// The first form vendors the registry, DKG and verifier ABIs into abi/; the
// second vendors the on-chain census contracts (the davinci-zkvm branch) into
// abi/census/, and the creation code of OwnedCensus and PoseidonT3 into
// test/e2e/contracts/census.json, which the live suite deploys on Gnosis
// (the anvil suite checks it against its own build). The ABIs are read from
// the forge build output (`out/` by default). The script refuses a checkout
// with uncommitted changes under src/ and a build whose sources differ from
// the checkout (every source a vendored artifact's metadata names, plus the
// build-info sources when the build kept them), so the recorded commit is the
// one the ABIs were compiled from. To build without touching the checkout:
//
//   FOUNDRY_OUT=~/.cache/sdk-forge/out FOUNDRY_CACHE_PATH=~/.cache/sdk-forge/cache forge build
//   node scripts/sync-abis.mjs <checkout> --out ~/.cache/sdk-forge/out
//
// After a sync, run `yarn test:unit test/contracts/unit/abi.test.ts`: the drift
// test pins every selector, topic, error and struct layout the SDK relies on.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'ethers';

// Vendored file name -> forge artifact, relative to the out dir.
const SOURCES = {
  registry: {
    repository: 'https://github.com/vocdoni/davinci-contracts',
    dir: '.',
    contracts: {
      ProcessRegistry: 'ProcessRegistry.sol/ProcessRegistry.json',
      DavinciDKGAdapter: 'DavinciDKGAdapter.sol/DavinciDKGAdapter.json',
      ZiskVerifier: 'ZiskVerifier.sol/ZiskVerifier.json',
      ICensusValidator: 'ICensusValidator.sol/ICensusValidator.json',
      IDKGAppManager: 'IDKGAppManager.sol/IDKGAppManager.json',
      IDKGManager: 'IDKGManager.sol/IDKGManager.json',
    },
  },
  census: {
    repository: 'https://github.com/vocdoni/davinci-onchain-census-contract',
    dir: 'census',
    contracts: {
      OnchainCensus: 'OnchainCensus.sol/OnchainCensus.json',
      OwnedCensus: 'OwnedCensus.sol/OwnedCensus.json',
    },
    // Creation code for the live e2e suite, relative to the repository root.
    bytecode: {
      out: 'test/e2e/contracts/census.json',
      contracts: {
        PoseidonT3: 'PoseidonT3.sol/PoseidonT3.json',
        OwnedCensus: 'OwnedCensus.sol/OwnedCensus.json',
      },
    },
  },
};

function fail(msg) {
  console.error(`sync-abis: ${msg}`);
  process.exit(1);
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
let outDir;
if (outFlag !== -1) {
  outDir = args[outFlag + 1];
  if (!outDir) fail('--out needs a directory');
  args.splice(outFlag, 2);
}
const censusFlag = args.indexOf('--census');
if (censusFlag !== -1) args.splice(censusFlag, 1);
const source = SOURCES[censusFlag === -1 ? 'registry' : 'census'];
if (args.length !== 1) {
  fail('usage: node scripts/sync-abis.mjs [--census] <forge checkout> [--out <forge out dir>]');
}

const checkout = resolve(args[0]);
outDir = resolve(outDir ?? join(checkout, 'out'));
if (!existsSync(join(checkout, 'foundry.toml'))) fail(`${checkout} is not a foundry project`);
if (!existsSync(outDir)) fail(`${outDir} does not exist; run forge build first`);

const commit = git(checkout, 'rev-parse', 'HEAD');
if (git(checkout, 'status', '--porcelain', '--', 'src')) {
  fail(`${checkout} has uncommitted changes under src/; the ABIs would not match ${commit}`);
}

// Every src/ file the build compiled must equal the checkout's copy.
let checked = 0;
const buildInfoDir = join(outDir, 'build-info');
if (existsSync(buildInfoDir)) {
  for (const f of readdirSync(buildInfoDir).filter(n => n.endsWith('.json'))) {
    const info = JSON.parse(readFileSync(join(buildInfoDir, f), 'utf8'));
    for (const [path, src] of Object.entries(info.input?.sources ?? {})) {
      if (!path.startsWith('src/') || typeof src.content !== 'string') continue;
      const local = join(checkout, path);
      if (!existsSync(local) || readFileSync(local, 'utf8') !== src.content) {
        fail(`${path} differs from the build in ${outDir}; rebuild before syncing`);
      }
      checked++;
    }
  }
}

// A forge artifact, once every source it was compiled from matches the
// checkout (by the keccak256 solc recorded).
function checkedArtifact(artifact) {
  const path = join(outDir, artifact);
  if (!existsSync(path)) fail(`${path} is missing`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  for (const [src, { keccak256: want }] of Object.entries(json.metadata?.sources ?? {})) {
    const local = join(checkout, src);
    if (!existsSync(local) || keccak256(readFileSync(local)) !== want) {
      fail(`${src} differs from the build of ${artifact}; rebuild before syncing`);
    }
    checked++;
  }
  return json;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const abiDir = join(root, 'src', 'contracts', 'abi', source.dir);
const files = {};
for (const [name, artifact] of Object.entries(source.contracts)) {
  const { abi } = checkedArtifact(artifact);
  if (!Array.isArray(abi)) fail(`${join(outDir, artifact)} has no abi`);
  const text = `${JSON.stringify(abi, null, 2)}\n`;
  writeFileSync(join(abiDir, `${name}.json`), text);
  files[`${name}.json`] = createHash('sha256').update(text).digest('hex');
}

// Creation code: the bytecode with its library link references, and the
// keccak256 of the runtime code a deployment leaves.
let codes = 0;
if (source.bytecode) {
  const contracts = {};
  let compiler;
  for (const [name, artifact] of Object.entries(source.bytecode.contracts)) {
    const { bytecode, deployedBytecode, metadata } = checkedArtifact(artifact);
    // Hex, with a `__$<hash>$__` placeholder per library link.
    if (!/^0x[0-9a-f_$]+$/.test(bytecode?.object ?? '')) fail(`${artifact} has no bytecode`);
    compiler ??= metadata?.compiler?.version;
    const links = bytecode.linkReferences ?? {};
    contracts[name] =
      Object.keys(links).length > 0
        ? { bytecode: bytecode.object, linkReferences: links }
        : { bytecode: bytecode.object, deployedBytecodeHash: keccak256(deployedBytecode.object) };
    codes++;
  }
  const text = JSON.stringify(
    { repository: source.repository, commit, compiler, contracts },
    null,
    2
  );
  writeFileSync(join(root, source.bytecode.out), `${text}\n`);
}
if (checked === 0) fail(`no sources to check in ${outDir}; build with metadata or build_info`);

const record = { repository: source.repository, commit, files };
writeFileSync(join(abiDir, 'source.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `sync-abis: ${Object.keys(files).length} ABIs` +
    (codes > 0 ? ` and ${codes} creation codes` : '') +
    ` from ${commit} (${checked} sources checked)`
);
