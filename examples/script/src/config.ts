/**
 * What both examples share: the settings from `.env`, the uploader that
 * publishes census files and metadata documents, and small helpers.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  DavinciSDK,
  VoteError,
  type DavinciSDKConfig,
  type Uploader,
  type VoteConfig,
  type VoteResult,
} from '@vocdoni/davinci-sdk';
import { JsonRpcProvider, Wallet, type Signer } from 'ethers';

loadEnv();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: copy .env.example to .env and fill it in`);
  return value;
}

const list = (value?: string) =>
  (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/** The deployment's sequencer nodes: always configuration. */
export const NODES = list(process.env.DAVINCI_NODES);

/** The organizer's JSON-RPC, on the network's chain. */
export const RPC_URL = process.env.RPC_URL?.trim();

/** Development against local services: loopback and private hosts allowed. */
export const LOCAL = process.env.ALLOW_PRIVATE_HOSTS === 'true';

export function organizerSigner(): Signer {
  return new Wallet(required('PRIVATE_KEY'), new JsonRpcProvider(required('RPC_URL')));
}

/**
 * Publishes a document where nodes and readers can fetch it: into a local
 * directory a web server serves (`PUBLISH_DIR` and `PUBLISH_URL`), or with an
 * HTTP PUT (`UPLOAD_URL`, served at `PUBLIC_URL`). Swap in any store that
 * serves the bytes unchanged over public https.
 */
export function uploader(): Uploader {
  const dir = process.env.PUBLISH_DIR?.trim();
  if (dir) {
    const base = required('PUBLISH_URL').replace(/\/+$/, '');
    mkdirSync(dir, { recursive: true });
    return {
      upload({ data, sha256 }) {
        const name = `${sha256.slice(2)}.json`;
        writeFileSync(join(dir, name), data);
        return Promise.resolve(`${base}/${name}`);
      },
    };
  }
  const target = required('UPLOAD_URL').replace(/\/+$/, '');
  const base = required('PUBLIC_URL').replace(/\/+$/, '');
  return {
    async upload({ data, contentType, sha256 }) {
      const name = `${sha256.slice(2)}.json`;
      const res = await fetch(`${target}/${name}`, {
        method: 'PUT',
        body: new Uint8Array(data), // a copy fetch types accept
        headers: { 'content-type': contentType },
      });
      if (!res.ok) throw new Error(`upload of ${name} failed: HTTP ${res.status}`);
      return `${base}/${name}`;
    },
  };
}

/** A DavinciSDK for `signer` on the configured deployment, initialized. */
export async function connect(
  signer: Signer,
  extra: Partial<DavinciSDKConfig> = {}
): Promise<DavinciSDK> {
  if (NODES.length === 0) throw new Error('DAVINCI_NODES is not set: the sequencer node URLs');
  const sdk = new DavinciSDK({
    signer,
    sequencerUrls: NODES,
    rpcUrls: RPC_URL ? [RPC_URL] : undefined,
    artifacts: process.env.ARTIFACTS_DIR ? { dir: process.env.ARTIFACTS_DIR } : undefined,
    documents: { allowPrivateHosts: LOCAL },
    ...extra,
  });
  await sdk.init();
  return sdk;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Votes, waiting while the nodes have not picked the new process up yet (a
 * few blocks after its creation) or are busy.
 */
export async function voteWhenReady(sdk: DavinciSDK, vote: VoteConfig): Promise<VoteResult> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await sdk.submitVote(vote);
    } catch (err) {
      const retry = err instanceof VoteError && ['unavailable', 'busy'].includes(err.reason);
      if (!retry || attempt === 30) throw err;
      await sleep(10_000);
    }
  }
}

export const step = (n: number, what: string) => console.log(`\n[${n}] ${what}`);
export const info = (...what: unknown[]) => console.log('   ', ...what);
