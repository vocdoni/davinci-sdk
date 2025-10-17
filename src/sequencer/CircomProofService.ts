// src/ProofGenerator.ts
import { groth16 } from 'snarkjs';
import { sha256 } from 'ethers';

export interface ProofInputs {
  fields: string[];
  num_fields: string;
  unique_values: string;
  max_value: string;
  min_value: string;
  max_value_sum: string;
  min_value_sum: string;
  cost_exponent: string;
  cost_from_weight: string;
  address: string;
  weight: string;
  process_id: string;
  vote_id: string;
  encryption_pubkey: [string, string];
  k: string;
  cipherfields: string[];
  inputs_hash: string;
}

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

export interface CircomProofOptions {
  wasmUrl?: string;
  zkeyUrl?: string;
  vkeyUrl?: string;
  /** Optional SHA-256 hash to verify circuit WASM file integrity */
  wasmHash?: string;
  /** Optional SHA-256 hash to verify proving key file integrity */
  zkeyHash?: string;
  /** Optional SHA-256 hash to verify verification key file integrity */
  vkeyHash?: string;
}

export class CircomProof {
  private readonly wasmUrl?: string;
  private readonly zkeyUrl?: string;
  private readonly vkeyUrl?: string;
  private readonly wasmHash?: string;
  private readonly zkeyHash?: string;
  private readonly vkeyHash?: string;

  // simple in-memory cache keyed by URL
  private wasmCache = new Map<string, Uint8Array>();
  private zkeyCache = new Map<string, Uint8Array>();
  private vkeyCache = new Map<string, any>();

  constructor(opts: CircomProofOptions = {}) {
    this.wasmUrl = opts.wasmUrl;
    this.zkeyUrl = opts.zkeyUrl;
    this.vkeyUrl = opts.vkeyUrl;
    this.wasmHash = opts.wasmHash;
    this.zkeyHash = opts.zkeyHash;
    this.vkeyHash = opts.vkeyHash;
  }

  /**
   * Computes SHA-256 hash of the given data and compares it with the expected hash.
   * @param data - The data to hash (string or ArrayBuffer or Uint8Array)
   * @param expectedHash - The expected SHA-256 hash in hexadecimal format
   * @param filename - The filename for error reporting
   * @throws Error if the computed hash doesn't match the expected hash
   */
  private verifyHash(
    data: string | ArrayBuffer | Uint8Array,
    expectedHash: string,
    filename: string
  ): void {
    // Convert data to Uint8Array for hashing
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }

    // Compute SHA-256 hash using ethers
    const computedHash = sha256(bytes).slice(2); // Remove '0x' prefix

    // Compare hashes (case-insensitive)
    if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(
        `Hash verification failed for ${filename}. ` +
          `Expected: ${expectedHash.toLowerCase()}, ` +
          `Computed: ${computedHash.toLowerCase()}`
      );
    }
  }

  /**
   * Generate a zk‐SNARK proof.
   * If you didn't pass wasmUrl/zkeyUrl in the constructor you must supply them here.
   */
  async generate(
    inputs: ProofInputs,
    urls: { wasmUrl?: string; zkeyUrl?: string } = {}
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const wasmUrl = urls.wasmUrl ?? this.wasmUrl;
    const zkeyUrl = urls.zkeyUrl ?? this.zkeyUrl;
    if (!wasmUrl) throw new Error('`wasmUrl` is required to generate a proof');
    if (!zkeyUrl) throw new Error('`zkeyUrl` is required to generate a proof');

    // fetch+cache .wasm
    let wasmBin = this.wasmCache.get(wasmUrl);
    if (!wasmBin) {
      const r = await fetch(wasmUrl);
      if (!r.ok) throw new Error(`Failed to fetch wasm at ${wasmUrl}: ${r.status}`);
      const buf = await r.arrayBuffer();
      wasmBin = new Uint8Array(buf);

      // Verify hash if provided
      if (this.wasmHash) {
        this.verifyHash(wasmBin, this.wasmHash, 'circuit.wasm');
      }

      this.wasmCache.set(wasmUrl, wasmBin);
    }

    // fetch+cache .zkey
    let zkeyBin = this.zkeyCache.get(zkeyUrl);
    if (!zkeyBin) {
      const r = await fetch(zkeyUrl);
      if (!r.ok) throw new Error(`Failed to fetch zkey at ${zkeyUrl}: ${r.status}`);
      const buf = await r.arrayBuffer();
      zkeyBin = new Uint8Array(buf);

      // Verify hash if provided
      if (this.zkeyHash) {
        this.verifyHash(zkeyBin, this.zkeyHash, 'proving_key.zkey');
      }

      this.zkeyCache.set(zkeyUrl, zkeyBin);
    }

    const { proof, publicSignals } = await groth16.fullProve(inputs, wasmBin, zkeyBin);
    return {
      proof: proof as unknown as Groth16Proof,
      publicSignals: publicSignals as string[],
    };
  }

  async verify(
    proof: Groth16Proof,
    publicSignals: string[],
    urlOverride?: string
  ): Promise<boolean> {
    const vkeyUrl = urlOverride ?? this.vkeyUrl;
    if (!vkeyUrl) throw new Error('`vkeyUrl` is required to verify a proof');

    // fetch+cache vkey JSON
    let vk = this.vkeyCache.get(vkeyUrl);
    if (!vk) {
      const r = await fetch(vkeyUrl);
      if (!r.ok) throw new Error(`Failed to fetch vkey at ${vkeyUrl}: ${r.status}`);
      const vkeyText = await r.text();

      // Verify hash if provided
      if (this.vkeyHash) {
        this.verifyHash(vkeyText, this.vkeyHash, 'verification_key.json');
      }

      vk = JSON.parse(vkeyText);
      this.vkeyCache.set(vkeyUrl, vk);
    }

    return groth16.verify(vk, publicSignals, proof);
  }
}
