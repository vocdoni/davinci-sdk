/**
 * @fileoverview The anvil suite's chain: an anvil node with the davinci-contracts
 * registry deployed by its own `script/DeployAll.s.sol`, and what the tests
 * deploy from (an `OwnedCensus` of davinci-onchain-census-contract, linked to
 * its `PoseidonT3`).
 *
 * Two registries, both pinned to this release (`src/protocol/release.ts`) with
 * a short grace window:
 *
 * - `registry`: no DKG manager, as `DeployAll` deploys by default. Every
 *   sequencer-key flow runs here, and the DKG modes fail with `DKGDisabled`.
 * - `dkgRegistry`: the DKG manager is davinci-contracts' `MockDKG`
 *   (`test/mocks/MockDKG.sol`, what its forge tests use): the registry's real
 *   adapter, pool keys and organizer keys in real BabyJubJub math and the
 *   organizer secret checked on reveal. It skips the committee (its Schnorr
 *   proof check, key generation and decryption), which only a live
 *   davinci-dkg deployment exercises.
 *
 * The contract sources are the commits the vendored ABIs came from
 * (`src/contracts/abi/source.json`, `src/contracts/abi/census/source.json`).
 *
 * Env (also read from `test/.env`):
 * - `DAVINCI_CONTRACTS_DIR`, `DAVINCI_CENSUS_CONTRACT_DIR`: checkouts of
 *   davinci-contracts and davinci-onchain-census-contract, submodules
 *   included. Default: shallow clones of the pinned commits in the cache.
 * - `DAVINCI_ANVIL_CACHE`: clones, forge output and the anvil log; default
 *   `~/.cache/davinci-sdk-anvil`. Checkouts are never written to. One run
 *   uses a cache at a time: a second run waits for the first to finish.
 * - `FOUNDRY_BIN`: the directory of `forge` and `anvil`; default
 *   `~/.foundry/bin` when it has them, else `PATH`.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ContractFactory,
  JsonRpcProvider,
  Network,
  Wallet,
  getAddress,
  type InterfaceAbi,
} from 'ethers';
import type { TestProject } from 'vitest/node';
import { loadIntegrationEnv } from '../helpers/integrationEnv';
import { RELEASE_PINS } from '../../src/protocol/release';
import { ANVIL_CHAIN_ID, ANVIL_GRACE, devKey, type AnvilEnv } from './env';

const run = promisify(execFile);
const ROOT = resolve(__dirname, '../..');

interface Pin {
  repository: string;
  commit: string;
}

interface Artifact {
  abi: InterfaceAbi;
  bytecode: {
    object: string;
    linkReferences?: Record<string, Record<string, { start: number; length: number }[]>>;
  };
}

function pinOf(file: string): Pin {
  return JSON.parse(readFileSync(join(ROOT, 'src/contracts/abi', file), 'utf8')) as Pin;
}

function cacheDir(): string {
  const dir = process.env.DAVINCI_ANVIL_CACHE ?? join(homedir(), '.cache', 'davinci-sdk-anvil');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const NO_FOUNDRY = 'install Foundry (https://getfoundry.sh), or set FOUNDRY_BIN';

function tool(name: string): string {
  const dirs = [process.env.FOUNDRY_BIN, join(homedir(), '.foundry', 'bin')];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return name;
}

const sleep = (ms: number) => new Promise(ok => setTimeout(ok, ms));

// Whether process `pid` is running (EPERM: it is, as another user).
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes the cache for this run: clones, forge's build, cache and broadcast
 * records, and the anvil log are shared, so a second run waits (up to 30
 * minutes) for the first to finish. A lock whose run has died is taken over;
 * two runs taking over the same dead lock at the same instant could both
 * pass, which a crash followed by two simultaneous starts would need.
 *
 * @returns Releases the lock; safe to call more than once
 */
async function lockCache(): Promise<() => void> {
  const lock = join(cacheDir(), 'lock');
  const owner = join(lock, 'pid');
  const deadline = Date.now() + 30 * 60_000;
  let told = false;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(owner, String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let pid: number | undefined;
    try {
      pid = Number(readFileSync(owner, 'utf8'));
    } catch {
      // Just created, or its run died before writing: stale after a few seconds.
      const since = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (since !== undefined && Date.now() - since > 10_000) {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    if (pid !== undefined && !alive(pid)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`the anvil suite run ${pid ?? '?'} still holds ${lock} after 30 minutes`);
    }
    if (!told) {
      console.warn(`waiting for the anvil suite run ${pid ?? '?'} to finish (lock ${lock})`);
      told = true;
    }
    await sleep(500);
  }
  let held = true;
  return () => {
    if (held) rmSync(lock, { recursive: true, force: true });
    held = false;
  };
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 16 << 20 });
  return stdout.trim();
}

// The checkout of `pin`: the one named by `envName`, else a shallow clone of
// the pinned commit in the cache (made once, then reused).
async function checkout(envName: string, pin: Pin): Promise<string> {
  const given = process.env[envName];
  if (given) {
    const dir = resolve(given);
    if (!existsSync(join(dir, 'foundry.toml'))) {
      throw new Error(`${envName}=${given} is not a foundry project`);
    }
    const head = await git(dir, 'rev-parse', 'HEAD').catch(() => 'unknown');
    if (head !== pin.commit) {
      console.warn(
        `${envName} is at ${head}, not ${pin.commit} (the vendored ABIs' commit): ` +
          'the suite tests other contracts than the SDK was built against'
      );
    }
    return dir;
  }
  const dir = join(cacheDir(), 'src', `${basename(pin.repository)}-${pin.commit.slice(0, 12)}`);
  if (existsSync(join(dir, 'foundry.toml'))) return dir;
  const tmp = `${dir}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await git(tmp, 'init', '-q');
  await git(tmp, 'remote', 'add', 'origin', pin.repository);
  await git(tmp, 'fetch', '-q', '--depth', '1', 'origin', pin.commit);
  await git(tmp, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD');
  await git(tmp, 'submodule', 'update', '-q', '--init', '--recursive', '--depth', '1');
  renameSync(tmp, dir);
  return dir;
}

// Where forge keeps the build, cache and broadcasts of the checkout at `dir`.
function forgeDir(dir: string): string {
  const id = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  return join(cacheDir(), 'forge', `${basename(dir)}-${id}`);
}

// forge in `dir`, its build output and caches outside the checkout.
async function forge(dir: string, args: string[], env: Record<string, string> = {}) {
  const out = forgeDir(dir);
  try {
    return await run(tool('forge'), args, {
      cwd: dir,
      maxBuffer: 64 << 20,
      env: {
        ...process.env,
        ...env,
        FOUNDRY_OUT: join(out, 'out'),
        FOUNDRY_CACHE_PATH: join(out, 'cache'),
        FOUNDRY_BROADCAST: join(out, 'broadcast'),
        FOUNDRY_LINT_LINT_ON_BUILD: 'false',
        NO_COLOR: '1',
      },
    });
  } catch (err) {
    const e = err as { code?: unknown; stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') throw new Error(`cannot run ${tool('forge')}: ${NO_FOUNDRY}`);
    throw new Error(
      `forge ${args.join(' ')} failed in ${dir}:\n${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim()
    );
  }
}

function artifact(dir: string, path: string): Artifact {
  return JSON.parse(readFileSync(join(forgeDir(dir), 'out', path), 'utf8')) as Artifact;
}

// Bytecode with every library placeholder replaced by the library's address.
function linked(a: Artifact, libraries: Record<string, string>): string {
  let code = a.bytecode.object.replace(/^0x/, '');
  for (const byLib of Object.values(a.bytecode.linkReferences ?? {})) {
    for (const [lib, refs] of Object.entries(byLib)) {
      const address = libraries[lib];
      if (!address) throw new Error(`no address for library ${lib}`);
      for (const { start, length } of refs) {
        const at = start * 2;
        code = code.slice(0, at) + address.slice(2).toLowerCase() + code.slice(at + length * 2);
      }
    }
  }
  if (code.includes('__$')) throw new Error('bytecode still has library placeholders');
  return `0x${code}`;
}

// anvil on a port it picks itself (it prints it), its output in `log`.
async function startAnvil(log: string): Promise<{ child: ChildProcess; url: string }> {
  const bin = tool('anvil');
  const child = spawn(
    bin,
    [
      ...['--host', '127.0.0.1', '--port', '0'],
      ...['--chain-id', String(ANVIL_CHAIN_ID), '--hardfork', 'osaka', '--accounts', '20'],
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } }
  );
  const out = createWriteStream(log);
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.once('close', () => out.end());
  const url = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`anvil is not listening after 30 s; see ${log}`));
    }, 30_000);
    const failWith = (err: Error) => {
      clearTimeout(timer);
      fail(err);
    };
    child.once('error', err =>
      failWith(new Error(`cannot run ${bin}: ${err.message}; ${NO_FOUNDRY}`))
    );
    child.once('exit', code =>
      failWith(new Error(`anvil exited with ${String(code)} before listening; see ${log}`))
    );
    let seen = '';
    const listening = (chunk: Buffer) => {
      seen += chunk.toString();
      const at = /Listening on (127\.0\.0\.1:\d+)/.exec(seen);
      if (!at) return;
      clearTimeout(timer);
      child.stdout.off('data', listening);
      ok(`http://${at[1]}`);
    };
    child.stdout.on('data', listening);
  });
  return { child, url };
}

// `DeployAll.s.sol` with the release pins and the suite's grace window; the
// registry address and its deployment block from the broadcast record.
async function deployAll(
  dir: string,
  url: string,
  dkgManager?: string
): Promise<{ address: string; block: number }> {
  await forge(
    dir,
    ['script', 'script/DeployAll.s.sol:DeployAllScript', '--rpc-url', url, '--broadcast'],
    {
      PRIVATE_KEY: devKey(0),
      CHAIN_ID: String(ANVIL_CHAIN_ID),
      BATCH_PROGRAM_VK: RELEASE_PINS.batchProgramVK,
      RESULTS_PROGRAM_VK: RELEASE_PINS.resultsProgramVK,
      ROOT_C_VADCOP_FINAL: RELEASE_PINS.rootCVadcopFinal,
      BALLOT_VK_HASH: RELEASE_PINS.ballotVKHash,
      GRACE_DEFAULT: String(ANVIL_GRACE.defaultGrace),
      GRACE_FLOOR: String(ANVIL_GRACE.graceFloor),
      GRACE_CEIL: String(ANVIL_GRACE.graceCeil),
      GRACE_MAX_TOTAL: String(ANVIL_GRACE.graceMaxTotal),
      NOTICE_MIN: String(ANVIL_GRACE.noticeMin),
      ...(dkgManager && { DKG_MANAGER: dkgManager }),
    }
  );
  const record = join(
    forgeDir(dir),
    'broadcast',
    'DeployAll.s.sol',
    String(ANVIL_CHAIN_ID),
    'run-latest.json'
  );
  const broadcast = JSON.parse(readFileSync(record, 'utf8')) as {
    transactions: { hash: string; contractName?: string; contractAddress?: string }[];
    receipts: { transactionHash: string; blockNumber: string }[];
  };
  const tx = broadcast.transactions.find(t => t.contractName === 'ProcessRegistry');
  const receipt = broadcast.receipts.find(r => r.transactionHash === tx?.hash);
  if (!tx?.contractAddress || !receipt) throw new Error(`no ProcessRegistry in ${record}`);
  return { address: getAddress(tx.contractAddress), block: Number(receipt.blockNumber) };
}

async function deploy(wallet: Wallet, a: Artifact): Promise<string> {
  const contract = await new ContractFactory(a.abi, a.bytecode.object, wallet).deploy();
  await contract.waitForDeployment();
  return getAddress(await contract.getAddress());
}

/** Starts anvil, deploys, and hands the tests an {@link AnvilEnv}; stops anvil after. */
export default async function setup(project: TestProject): Promise<() => void> {
  loadIntegrationEnv();
  const unlock = await lockCache();
  let child: ChildProcess | undefined;
  const stop = () => {
    if (child && child.exitCode === null) child.kill();
    unlock();
  };
  process.once('exit', stop);
  try {
    const [contracts, census] = await Promise.all([
      checkout('DAVINCI_CONTRACTS_DIR', pinOf('source.json')),
      checkout('DAVINCI_CENSUS_CONTRACT_DIR', pinOf('census/source.json')),
    ]);
    await Promise.all([forge(contracts, ['build']), forge(census, ['build'])]);

    const anvil = await startAnvil(join(cacheDir(), 'anvil.log'));
    child = anvil.child;
    const network = Network.from(ANVIL_CHAIN_ID);
    const provider = new JsonRpcProvider(anvil.url, network, { staticNetwork: network });
    const deployer = new Wallet(devKey(0), provider);

    const main = await deployAll(contracts, anvil.url);
    const mockDkg = artifact(contracts, 'MockDKG.sol/MockDKG.json');
    const mockDkgAddress = await deploy(deployer, mockDkg);
    const withDkg = await deployAll(contracts, anvil.url, mockDkgAddress);

    const poseidon = await deploy(deployer, artifact(census, 'PoseidonT3.sol/PoseidonT3.json'));
    const ownedCensus = linked(artifact(census, 'OwnedCensus.sol/OwnedCensus.json'), {
      PoseidonT3: poseidon,
    });
    provider.destroy();

    const env: AnvilEnv = {
      rpcUrl: anvil.url,
      registry: main.address,
      registryBlock: main.block,
      dkgRegistry: withDkg.address,
      dkgRegistryBlock: withDkg.block,
      mockDkg: mockDkgAddress,
      mockDkgAbi: JSON.stringify(mockDkg.abi),
      ownedCensusBytecode: ownedCensus,
    };
    project.provide('anvil', env);
  } catch (err) {
    stop();
    throw err;
  }
  return stop;
}
