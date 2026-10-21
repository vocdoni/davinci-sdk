/**
 * @fileoverview Settings of the live conformance suite (`test/e2e/live_conformance_*.test.ts`):
 * negative-path and lifecycle checks against one sequencer node and the OP Mainnet
 * registry, with a test organizer. Skipped unless `DAVINCI_CONFORMANCE=1`.
 *
 * - `DAVINCI_E2E_NODES`: the node URL (the first one is used).
 * - `DAVINCI_E2E_ORGANIZER_KEY`: the path of the organizer's key file; the key is read
 *   from it and never printed.
 * - `DAVINCI_E2E_CONFIRM_MAINNET=1`: the suite sends real transactions.
 * - `DAVINCI_E2E_RPC`: OP Mainnet JSON-RPCs tried before the preset's.
 * - `DAVINCI_CONFORMANCE_DIR`: where evidence (JSON lines, no secrets) and the
 *   organizer lock go; outside the repository.
 * - `DAVINCI_CONFORMANCE_MAX_PROCESSES` (default 8), `DAVINCI_CONFORMANCE_BUDGET_WEI`
 *   (default 0.25 mETH), `DAVINCI_CONFORMANCE_BUDGET_BASE_WEI` (the balance the budget
 *   counts from, default 0.3 mETH): hard stops before any transaction.
 * - `DAVINCI_CONFORMANCE_RPS` (default 4): node requests per second from this process.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEther } from 'ethers';
import { OPTIMISM } from '../../../src/networks';

export const enabled = (): boolean => process.env.DAVINCI_CONFORMANCE?.trim() === '1';

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');

export interface Settings {
  node: string;
  organizerKeyFile: string;
  rpcUrls: string[];
  dir: string;
  artifactsDir: string;
  maxProcesses: number;
  budgetWei: bigint;
  budgetBaseWei: bigint;
  rps: number;
}

const REPO = resolve(__dirname, '../../..');

export function settings(): Settings {
  const node = list(process.env.DAVINCI_E2E_NODES)[0];
  const key = process.env.DAVINCI_E2E_ORGANIZER_KEY?.trim();
  if (!node || !key) {
    throw new Error('the conformance suite needs DAVINCI_E2E_NODES and DAVINCI_E2E_ORGANIZER_KEY');
  }
  if (process.env.DAVINCI_E2E_CONFIRM_MAINNET?.trim() !== '1') {
    throw new Error('set DAVINCI_E2E_CONFIRM_MAINNET=1: the suite sends real transactions');
  }
  const dir = resolve(
    process.env.DAVINCI_CONFORMANCE_DIR?.trim() || join(homedir(), '.cache', 'davinci-conformance')
  );
  if (dir === REPO || dir.startsWith(`${REPO}/`)) {
    throw new Error(`DAVINCI_CONFORMANCE_DIR=${dir} is inside the repository`);
  }
  const big = (name: string, fallback: bigint) => {
    const v = process.env[name]?.trim();
    return v ? BigInt(v) : fallback;
  };
  return {
    node: node.replace(/\/+$/, ''),
    organizerKeyFile: resolve(key),
    rpcUrls: [...new Set([...list(process.env.DAVINCI_E2E_RPC), ...OPTIMISM.rpcUrls])],
    dir,
    artifactsDir: resolve(
      process.env.DAVINCI_SDK_E2E_ARTIFACTS?.trim() ||
        join(homedir(), '.cache', 'davinci-sdk-e2e', 'artifacts')
    ),
    maxProcesses: Number(process.env.DAVINCI_CONFORMANCE_MAX_PROCESSES ?? 8),
    budgetWei: big('DAVINCI_CONFORMANCE_BUDGET_WEI', parseEther('0.00025')),
    budgetBaseWei: big('DAVINCI_CONFORMANCE_BUDGET_BASE_WEI', parseEther('0.0003')),
    rps: Number(process.env.DAVINCI_CONFORMANCE_RPS ?? 4),
  };
}
