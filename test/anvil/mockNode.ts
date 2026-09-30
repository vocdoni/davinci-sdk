/**
 * @fileoverview A stand-in for one sequencer node and a file host, on one
 * local HTTP server: what the organizer flows need from a node, and no more.
 *
 * - `GET /info` reports the chain, the registry and the pins the registry
 *   holds (read from it at start), so `DavinciSDK.init()` accepts the node.
 * - `POST /processes/keys` issues a key the way a node does: a prime-order
 *   point, the same one for the same process id.
 * - `GET /processes/{pid}/participants/{address}` answers for a census file
 *   uploaded here, at the root the registry holds for the process, with its
 *   lean-IMT proof.
 * - Everything else a node serves is 404 with code 40401: no vote was ever
 *   taken here.
 * - `uploader` stores census files and metadata documents, served back under
 *   `/files/<sha256>.json`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Wallet, getAddress, keccak256, toUtf8Bytes, toUtf8String } from 'ethers';
import type { ProcessRegistryService } from '../../src/contracts/ProcessRegistryService';
import { BJJ_SUBGROUP_ORDER, bjjMulBase, type BjjPoint } from '../../src/crypto/babyjubjub';
import { OffchainCensus } from '../../src/census/classes/OffchainCensus';
import type { Uploader, UploadRequest } from '../../src/core/types/uploader';

interface File {
  body: Uint8Array;
  contentType: string;
}

const NOT_FOUND = { error: 'not found', code: 40401 };

export class MockNode {
  /** Every request, as `METHOD /path`. */
  readonly requests: string[] = [];
  /** The process ids keys were issued for, in order. */
  readonly keyRequests: string[] = [];
  /** What was uploaded, in order. */
  readonly uploads: UploadRequest[] = [];
  /** `/info` fields to report instead of the registry's (a node of another deployment). */
  info: Record<string, unknown> = {};
  /** Answer `POST /processes/keys` with this instead of a key. */
  keyError?: { status: number; body: unknown };

  private readonly files = new Map<string, File>();
  private readonly censuses = new Map<bigint, OffchainCensus>();
  private readonly address = Wallet.createRandom().address;
  private pins?: Record<string, unknown>;
  private readonly server = createServer((req, res) => {
    this.handle(req, res).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err), code: 50001 }));
    });
  });

  private constructor(private readonly registry: ProcessRegistryService) {}

  /** A node serving `registry`'s deployment, listening on a free loopback port. */
  static async start(registry: ProcessRegistryService): Promise<MockNode> {
    const node = new MockNode(registry);
    const [chainId, ballotVkHash, batchProgramVk, resultsProgramVk] = await Promise.all([
      registry.getChainID(),
      registry.getBallotVKHash(),
      registry.getBatchProgramVK(),
      registry.getResultsProgramVK(),
    ]);
    node.pins = {
      chainId: Number(chainId),
      processRegistry: registry.address,
      ballotVkHash,
      batchProgramVk,
      resultsProgramVk,
    };
    await new Promise<void>(ok => node.server.listen(0, '127.0.0.1', ok));
    return node;
  }

  /** The node's base URL. */
  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Stores uploads under `/files/<sha256>.json`; census files are also indexed by root. */
  readonly uploader: Uploader = {
    upload: async (request: UploadRequest) => {
      this.uploads.push(request);
      if (request.kind === 'census') {
        const census = OffchainCensus.fromJSON(request.data);
        this.censuses.set(BigInt(await census.root()), census);
      }
      return this.serve(`/files/${request.sha256.slice(2)}.json`, request.data);
    },
  };

  /** Serves `body` at `path` (replacing what was there) and returns its URL. */
  serve(path: string, body: string | Uint8Array, contentType = 'application/json'): string {
    this.files.set(path, {
      body: typeof body === 'string' ? toUtf8Bytes(body) : body,
      contentType,
    });
    return `${this.url}${path}`;
  }

  /** The key this node issues for `processId`. */
  keyOf(processId: string): BjjPoint {
    const secret =
      (BigInt(keccak256(toUtf8Bytes(processId.toLowerCase()))) % (BJJ_SUBGROUP_ORDER - 1n)) + 1n;
    return bjjMulBase(secret);
  }

  /** Stops the server. */
  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise(ok => this.server.close(() => ok()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', this.url).pathname;
    this.requests.push(`${req.method ?? 'GET'} ${path}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const file = req.method === 'GET' ? this.files.get(path) : undefined;
    if (file) {
      res.writeHead(200, { 'content-type': file.contentType });
      res.end(file.body);
      return;
    }
    if (req.method === 'GET' && path === '/info') {
      json(200, {
        sequencerAddress: this.address,
        ...this.pins,
        observer: false,
        settledBySelf: 0,
        syncedFromOthers: 0,
        lostRaces: 0,
        ...this.info,
      });
      return;
    }
    if (req.method === 'GET' && path === '/ping') {
      json(200, {});
      return;
    }
    if (req.method === 'POST' && path === '/processes/keys') {
      const body = JSON.parse(await readBody(req)) as { processId?: unknown };
      const processId = String(body.processId);
      this.keyRequests.push(processId);
      if (this.keyError) {
        json(this.keyError.status, this.keyError.body);
        return;
      }
      const key = this.keyOf(processId);
      json(200, { x: key.x.toString(), y: key.y.toString() });
      return;
    }
    const participant = /^\/processes\/(0x[0-9a-f]{62})\/participants\/(0x[0-9a-f]{40})$/.exec(
      path
    );
    if (req.method === 'GET' && participant) {
      const [, processId, voter] = participant;
      const { census } = await this.registry.getProcess(processId);
      const members = this.censuses.get(BigInt(census.root));
      const weight = members?.getWeight(voter);
      if (!members || weight === undefined) {
        json(404, NOT_FOUND);
        return;
      }
      const proof = await members.proof(voter);
      json(200, {
        address: getAddress(voter),
        weight,
        censusProof: {
          root: proof.root.toString(),
          leaf: proof.leaf.toString(),
          pathBits: Number(proof.pathBits),
          siblings: proof.siblings.map(s => s.toString()),
        },
      });
      return;
    }
    json(404, NOT_FOUND);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return toUtf8String(Buffer.concat(chunks));
}
