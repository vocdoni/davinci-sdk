/**
 * @fileoverview What the anvil tests share: the chain the global setup
 * started, dev accounts, the chain clock, transaction streams, census
 * contracts and an SDK connected to a registry and a mock node.
 */

import { createServer, type AddressInfo } from 'node:net';
import { ContractFactory, JsonRpcProvider, Network, Wallet, getAddress } from 'ethers';
import { expect, inject } from 'vitest';
import { DavinciSDK, type DavinciSDKConfig } from '../../src/DavinciSDK';
import { OWNED_CENSUS_ABI } from '../../src/contracts/abis';
import { ProcessRegistryService } from '../../src/contracts/ProcessRegistryService';
import { TxStatus, type TxStatusEvent } from '../../src/contracts/SmartContractService';
import type { Census } from '../../src/census/classes/Census';
import type { ProcessConfig, ProcessConfigWithMetadata } from '../../src/core/process';
import { ANVIL_CHAIN_ID, devKey, type AnvilEnv } from './env';
import { MockNode } from './mockNode';

export { ANVIL_GRACE } from './env';
export { MockNode } from './mockNode';

/** The chain and contracts of this run. */
export const anvil = (): AnvilEnv => inject('anvil');

const network = Network.from(ANVIL_CHAIN_ID);

/**
 * A provider on the suite's anvil. No request cache, so a read right after a
 * time warp sees the new head, and fast receipt polling.
 */
export function chainProvider(): JsonRpcProvider {
  return new JsonRpcProvider(anvil().rpcUrl, network, {
    staticNetwork: network,
    cacheTimeout: -1,
    pollingInterval: 50,
  });
}

let shared: JsonRpcProvider | undefined;
const rpcProvider = () => (shared ??= chainProvider());

/** Dev account `i` (1 and up; 0 deployed the contracts), connected to the chain. */
export function devWallet(i: number, provider: JsonRpcProvider = rpcProvider()): Wallet {
  return new Wallet(devKey(i), provider);
}

/** A JSON-RPC call to anvil. */
export function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  return rpcProvider().send(method, params) as Promise<T>;
}

// ─── The chain clock ─────────────────────────────────────────────────

/** The head block's time. */
export async function chainTime(): Promise<bigint> {
  const head = await rpcProvider().getBlock('latest');
  if (!head) throw new Error('no head block');
  return BigInt(head.timestamp);
}

/** Mines an empty block at time `t`: the head the SDK and simulations see. */
export async function mineAt(t: bigint): Promise<void> {
  await rpc('evm_mine', [Number(t)]);
}

/** The next block (the next transaction's, with automine) lands at time `t`. */
export async function nextBlockAt(t: bigint): Promise<void> {
  await rpc('evm_setNextBlockTimestamp', [Number(t)]);
}

/** Moves the clock at least `seconds` forward and mines a block there; its time. */
export async function warp(seconds: number | bigint): Promise<bigint> {
  const before = await chainTime();
  await rpc('evm_increaseTime', [Number(seconds)]);
  await rpc('evm_mine');
  const after = await chainTime();
  expect(after - before).toBeGreaterThanOrEqual(BigInt(seconds));
  return after;
}

/** Runs `fn` with automine off: transactions wait in the pool for `mine()`. */
export async function withoutAutomine<T>(fn: () => Promise<T>): Promise<T> {
  await rpc('evm_setAutomine', [false]);
  try {
    return await fn();
  } finally {
    await rpc('evm_setAutomine', [true]);
  }
}

/** Mines one block. */
export async function mine(): Promise<void> {
  await rpc('evm_mine');
}

// ─── Transaction streams ─────────────────────────────────────────────

/** Every event of a transaction stream. */
export async function collect<T>(
  stream: AsyncGenerator<TxStatusEvent<T>>
): Promise<TxStatusEvent<T>[]> {
  const events: TxStatusEvent<T>[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The error a stream ended with, from its `Failed` or `Reverted` event. */
export async function streamError<T>(stream: AsyncGenerator<TxStatusEvent<T>>): Promise<Error> {
  const events = await collect(stream);
  const last = events[events.length - 1];
  if (last?.status === TxStatus.Failed) return last.error;
  if (last?.status === TxStatus.Reverted && last.error) return last.error;
  throw new Error(`the stream did not fail: ${events.map(e => e.status).join(', ')}`);
}

/** The next event of a stream, which must be there. */
export async function nextEvent<T>(
  stream: AsyncGenerator<TxStatusEvent<T>>
): Promise<TxStatusEvent<T>> {
  const next = await stream.next();
  if (next.done) throw new Error('the stream ended');
  return next.value;
}

/**
 * Runs `stream` until its transaction is sent, with the pending block (where
 * anvil estimates gas) at the head's time, then mines that transaction at
 * `t`: a change checked and simulated at the head can still revert where it
 * lands.
 */
export async function landAt<T>(
  t: bigint,
  stream: AsyncGenerator<TxStatusEvent<T>>
): Promise<TxStatusEvent<T>[]> {
  return withoutAutomine(async () => {
    await nextBlockAt(await chainTime());
    const first = await nextEvent(stream);
    if (first.status !== TxStatus.Pending) return [first];
    await nextBlockAt(t);
    await mine();
    return [first, ...(await collect(stream))];
  });
}

/**
 * Runs a change that the registry allows only before a process's `end`
 * across that boundary, and checks every layer refuses it from the end on:
 *
 * 1. Landing at `end - 1` it goes through.
 * 2. Checked and simulated at `end - 1` but landing at `end`, it reverts on
 *    chain, and the replay names `InvalidTimeBounds`.
 * 3. With the head at `end`, the SDK refuses it before simulating.
 * 4. The raw registry service's simulation reverts `InvalidTimeBounds`.
 */
export async function acrossTheEnd(
  end: bigint,
  change: () => AsyncGenerator<TxStatusEvent<unknown>>,
  raw: () => AsyncGenerator<TxStatusEvent<unknown>>
): Promise<void> {
  await mineAt(end - 2n);
  await nextBlockAt(end - 1n);
  const before = await collect(change());
  expect(before.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Completed]);

  const mined = await landAt(end, change());
  expect(mined.map(e => e.status)).toEqual([TxStatus.Pending, TxStatus.Reverted]);
  expect(mined[1]).toMatchObject({ reason: 'InvalidTimeBounds' });
  expect(await chainTime()).toBe(end);

  const local = await streamError(change());
  expect(local).toMatchObject({ revertName: 'InvalidTimeBounds' });
  expect(local.message).toMatch(/only before the end/);

  const simulated = await streamError(raw());
  expect(simulated).toMatchObject({ revertName: 'InvalidTimeBounds' });
  expect(simulated.message).toMatch(/reverted: InvalidTimeBounds/);
}

// ─── Contracts ───────────────────────────────────────────────────────

/** The main registry (no DKG) or the one on the mock DKG, with `runner`. */
export function registryService(
  runner: Wallet | JsonRpcProvider,
  which: 'main' | 'dkg' = 'main'
): ProcessRegistryService {
  const env = anvil();
  return new ProcessRegistryService(which === 'main' ? env.registry : env.dkgRegistry, runner);
}

/** Deploys an `OwnedCensus` owned by `owner`. */
export async function deployOwnedCensus(owner: Wallet): Promise<string> {
  const factory = new ContractFactory(OWNED_CENSUS_ABI, anvil().ownedCensusBytecode, owner);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return getAddress(await contract.getAddress());
}

// ─── The SDK ─────────────────────────────────────────────────────────

/** A node for the main registry or the DKG one. */
export function startNode(which: 'main' | 'dkg' = 'main'): Promise<MockNode> {
  return MockNode.start(registryService(rpcProvider(), which));
}

/**
 * An initialized SDK for dev account `account` on a registry, with `node` as
 * its only sequencer and uploader. Documents on loopback are allowed; the
 * deployment is checked against the release pins, as by default.
 */
export async function connect(
  account: number,
  node: MockNode,
  options: { registry?: 'main' | 'dkg'; config?: Partial<DavinciSDKConfig> } = {}
): Promise<DavinciSDK> {
  const env = anvil();
  const dkg = options.registry === 'dkg';
  const sdk = new DavinciSDK({
    signer: devWallet(account, chainProvider()),
    network: {
      name: 'anvil',
      chainId: ANVIL_CHAIN_ID,
      processRegistry: dkg ? env.dkgRegistry : env.registry,
      startBlock: dkg ? env.dkgRegistryBlock : env.registryBlock,
    },
    sequencerUrls: [node.url],
    uploader: node.uploader,
    documents: { allowPrivateHosts: true },
    ...options.config,
  });
  await sdk.init();
  return sdk;
}

/** A single-choice election over `census`, an hour long, with its metadata. */
export function election(
  census: Census | ProcessConfig['census'],
  overrides: Partial<ProcessConfigWithMetadata> = {}
): ProcessConfigWithMetadata {
  return {
    title: 'Anvil election',
    description: 'Created by the anvil suite',
    census,
    electionPreset: { type: 'single_choice' },
    questions: [
      {
        title: 'Should the park open at night?',
        choices: [
          { title: 'Yes', value: 0 },
          { title: 'No', value: 1 },
        ],
      },
    ],
    timing: { duration: 3600 },
    ...overrides,
  };
}

/** The URL of a loopback port nothing listens on: bound, then released. */
export async function unusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(ok => server.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}

/** `n` fresh addresses. */
export function addresses(n: number): string[] {
  return Array.from({ length: n }, () => Wallet.createRandom().address);
}
