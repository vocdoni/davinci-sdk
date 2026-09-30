/**
 * @fileoverview What every scenario of the run shares: the organizer's SDK
 * and account, the fixtures at their public URLs, the voters, the grace
 * settings and the circuit file cache. {@link connect} checks everything
 * before any transaction; {@link finish} prints the summary and the gas bill
 * and cancels what a failed run left open.
 */

import { readFileSync } from 'node:fs';
import { Wallet, formatEther, parseEther, type BaseWallet } from 'ethers';
import { DavinciSDK } from '../../../src/DavinciSDK';
import { checkCensusUrl } from '../../../src/census/publish';
import type { CensusProviders } from '../../../src/census/types';
import { ProcessStatus, type GraceParams } from '../../../src/contracts/types';
import { FailoverRpcProvider, GNOSIS, computeProcessId } from '../../../src/networks';
import { BallotProver } from '../../../src/prover/BallotProver';
import { DirArtifactCache } from '../artifactCache';
import { FIXTURES_DIR, redact, say, type RunSettings } from '../env';
import { FixtureHost, checkServed, fixtureDiff, isFixtureUrl, readFixtures } from '../hosting';
import { Organizer, formatBill } from '../organizer';
import { formatTable, type Row } from '../report';
import { fixtureFiles, votersOf, type Voters } from '../spec';
import { loadVoterKeys } from '../voters';

/** The organizer keeps at least this much, as the Rust live e2e does. */
export const MIN_BALANCE = parseEther('0.05');

/** How many of the organizer's latest processes a run checks for leftovers. */
const LEFTOVER_WINDOW = 16;

export interface Live {
  settings: RunSettings;
  /** The organizer's SDK: creations, controls and every read. */
  sdk: DavinciSDK;
  /** The organizer's account. */
  wallet: Wallet;
  /** Serializes the organizer's transactions and records them. */
  org: Organizer;
  host: FixtureHost;
  voters: Voters;
  grace: GraceParams;
  cache: DirArtifactCache;
  startBalance: bigint;
  startNonce: number;
  /** An initialized SDK for one voter, on the same nodes, RPCs and circuit files. */
  voterSdk(signer: BaseWallet, censusProviders?: CensusProviders): Promise<DavinciSDK>;
}

// The key file's key, `0x`-prefixed; its content is never printed.
function readKey(path: string): string {
  const text = readFileSync(path, 'utf8').trim();
  const key = text.startsWith('0x') ? text : `0x${text}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${path} does not hold a hex private key`);
  }
  return key;
}

/**
 * Checks the fixtures, the nodes, the registry and the organizer's funds,
 * then cancels what an interrupted earlier run left open. Nothing is created
 * here.
 */
export async function connect(settings: RunSettings): Promise<Live> {
  // The committed files are the ones the private keys give, and are served.
  const voters = votersOf(loadVoterKeys(settings.privateDir));
  const local = readFixtures(FIXTURES_DIR);
  const drift = fixtureDiff(fixtureFiles(voters), local);
  if (drift.length > 0) {
    throw new Error(
      `test/e2e/fixtures does not match the voter keys in ${settings.privateDir}: ` +
        `${drift.join(', ')}; run prepare, then commit and push`
    );
  }
  checkCensusUrl(`${settings.baseUrl}/x.json`);
  await checkServed(settings.baseUrl, local);
  say(`${local.size} fixtures served as committed`);

  const cache = new DirArtifactCache(settings.artifactsDir);
  const host = new FixtureHost(settings.baseUrl, local);
  const provider = new FailoverRpcProvider(settings.rpcUrls, GNOSIS.chainId);
  const wallet = new Wallet(readKey(settings.organizerKeyFile), provider);
  const sdk = new DavinciSDK({
    signer: wallet,
    network: 'gnosis',
    sequencerUrls: settings.nodes,
    rpcUrls: settings.rpcUrls,
    uploader: host.uploader,
    artifacts: { cache },
  });
  await sdk.init();
  const unusable = sdk.nodeChecks.filter(c => c.status !== 'usable');
  if (unusable.length > 0) {
    throw new Error(
      `every node must take votes: ${unusable.map(c => `${c.url} (${c.reason ?? c.status})`).join(', ')}`
    );
  }
  say(`registry ${sdk.network.processRegistry} checked; ${settings.nodes.length} nodes usable`);

  const [balance, grace, adapter] = await Promise.all([
    provider.getBalance(wallet.address),
    sdk.getGraceParams(),
    sdk.registry.getDkgAdapter(),
  ]);
  say(`organizer ${wallet.address}: ${formatEther(balance)} xDAI`);
  if (balance < MIN_BALANCE) {
    throw new Error(
      `the organizer holds ${formatEther(balance)} xDAI, below ${formatEther(MIN_BALANCE)}`
    );
  }
  if (!adapter) throw new Error('the registry has no DKG adapter: the DKG scenarios cannot run');
  say(
    `grace: default ${grace.defaultGrace} s, floor ${grace.graceFloor} s, ceil ${grace.graceCeil} s, ` +
      `max total ${grace.graceMaxTotal} s, notice ${grace.noticeMin} s`
  );

  const org = new Organizer();
  await cancelLeftovers(sdk, wallet.address, settings.baseUrl, org);
  const startNonce = await provider.getTransactionCount(wallet.address, 'latest');
  const startBalance = await provider.getBalance(wallet.address);

  return {
    settings,
    sdk,
    wallet,
    org,
    host,
    voters,
    grace,
    cache,
    startBalance,
    startNonce,
    async voterSdk(signer, censusProviders) {
      const voter = new DavinciSDK({
        signer,
        network: 'gnosis',
        sequencerUrls: settings.nodes,
        rpcUrls: settings.rpcUrls,
        artifacts: { cache },
        censusProviders,
      });
      await voter.init();
      return voter;
    },
  };
}

// An interrupted run leaves its processes open. Among the account's latest
// processes, only those still READY or PAUSED whose metadata is one of this
// suite's fixtures are canceled: never anything else the account created.
async function cancelLeftovers(
  sdk: DavinciSDK,
  organizer: string,
  baseUrl: string,
  org: Organizer
): Promise<void> {
  const nonce = Number(await sdk.registry.getProcessNonce(organizer));
  const latest = Array.from({ length: Math.min(nonce, LEFTOVER_WINDOW) }, (_, i) =>
    computeProcessId(organizer, sdk.network.processIdPrefix, nonce - 1 - i)
  );
  const processIds: string[] = [];
  for (const pid of latest) {
    const p = await sdk.registry.getProcess(pid);
    const open = p.status === ProcessStatus.READY || p.status === ProcessStatus.PAUSED;
    if (open && isFixtureUrl(p.metadataUri, baseUrl)) processIds.push(pid);
    else if (open) say(`leftover check: ${pid} is open but not this suite's; left alone`);
  }
  if (processIds.length === 0) return;
  const { canceled, failed } = await org.exclusive(() => sdk.cancelOpenProcesses({ processIds }));
  if (canceled.length > 0) {
    say(`canceled ${canceled.length} leftovers of an earlier run: ${canceled.join(', ')}`);
  }
  for (const f of failed) say(`leftover ${f.processId} not canceled: ${f.error.message}`);
}

/**
 * Prints the scenario table and the organizer's gas bill; after a failure,
 * cancels the processes this run left open first.
 */
export async function finish(live: Live | undefined, rows: readonly Row[]): Promise<void> {
  try {
    if (!live) return;
    if (rows.some(r => r.result !== 'pass')) {
      try {
        const { canceled, failed } = await live.org.exclusive(() => live.sdk.cancelOpenProcesses());
        say(`after the failure: canceled ${canceled.length} open processes`);
        for (const f of failed) say(`  ${f.processId} not canceled: ${f.error.message}`);
      } catch (err) {
        say(
          `after the failure: canceling failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const sorted = [...rows].sort((a, b) => a.scenario.localeCompare(b.scenario));
    process.stderr.write(`\n${redact(formatTable(sorted))}\n\n`);
    const provider = live.wallet.provider as FailoverRpcProvider;
    const [lines, balance, nonce] = await Promise.all([
      live.org.bill(provider),
      provider.getBalance(live.wallet.address),
      provider.getTransactionCount(live.wallet.address, 'latest'),
    ]);
    process.stderr.write(`${formatBill(lines)}\n`);
    const sent = nonce - live.startNonce;
    process.stderr.write(
      `balance ${formatEther(live.startBalance)} -> ${formatEther(balance)} xDAI ` +
        `(spent ${formatEther(live.startBalance - balance)}); ${sent} transactions by nonce` +
        (sent === lines.length ? '' : ` (${sent - lines.length} not itemized: cancellations)`) +
        '\n\n'
    );
  } finally {
    await BallotProver.terminate();
  }
}
