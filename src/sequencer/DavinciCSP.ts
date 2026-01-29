import { CensusOrigin } from '../census/types';
import { sha256 } from 'ethers';

export interface CSPSignOutput {
  censusOrigin: CensusOrigin;
  root: string;
  address: string;
  weight: string;
  processId: string;
  publicKey: string;
  signature: string;
}

// internal shapes returned by the Go runtime
interface RawResult<T = any> {
  error?: string;
  data?: T;
}

interface GoDavinciCryptoWasm {
  cspSign(
    censusOrigin: number,
    privKey: string,
    processId: string,
    address: string,
    weight: string
  ): RawResult<CSPSignOutput>;
  cspVerify(cspProof: string): RawResult<boolean>;
  cspCensusRoot(censusOrigin: number, privKey: string): RawResult<{ root: string }>;
}

// Note: Global declarations are in DavinciCryptoService.ts to avoid duplication

export interface DavinciCSPOptions {
  /** URL to wasm_exec.js */
  wasmExecUrl: string;
  /** URL to the compiled davinci_crypto.wasm */
  wasmUrl: string;
  /** How long (ms) to wait for the Go runtime to attach DavinciCrypto */
  initTimeoutMs?: number;
  /** Optional SHA-256 hash to verify wasm_exec.js integrity */
  wasmExecHash?: string;
  /** Optional SHA-256 hash to verify davinci_crypto.wasm integrity */
  wasmHash?: string;
}

export class DavinciCSP {
  private go!: InstanceType<typeof Go>;
  private initialized = false;
  private readonly wasmExecUrl: string;
  private readonly wasmUrl: string;
  private readonly initTimeoutMs: number;
  private readonly wasmExecHash?: string;
  private readonly wasmHash?: string;

  // Cache for wasm files
  private static wasmExecCache = new Map<string, string>();
  private static wasmBinaryCache = new Map<string, ArrayBuffer>();

  constructor(opts: DavinciCSPOptions) {
    const { wasmExecUrl, wasmUrl, initTimeoutMs, wasmExecHash, wasmHash } = opts;

    if (!wasmExecUrl) throw new Error('`wasmExecUrl` is required');
    if (!wasmUrl) throw new Error('`wasmUrl` is required');

    this.wasmExecUrl = wasmExecUrl;
    this.wasmUrl = wasmUrl;
    this.initTimeoutMs = initTimeoutMs ?? 5_000;
    this.wasmExecHash = wasmExecHash;
    this.wasmHash = wasmHash;
  }

  /**
   * Computes SHA-256 hash of the given data and compares it with the expected hash.
   * @param data - The data to hash (string or ArrayBuffer)
   * @param expectedHash - The expected SHA-256 hash in hexadecimal format
   * @param filename - The filename for error reporting
   * @throws Error if the computed hash doesn't match the expected hash
   */
  private verifyHash(data: string | ArrayBuffer, expectedHash: string, filename: string): void {
    // Convert data to Uint8Array for hashing
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else {
      bytes = new Uint8Array(data);
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
   * Must be awaited before calling CSP functions.
   * Safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 1) Fetch & eval Go runtime shim (with caching and hash verification)
    let shimCode = DavinciCSP.wasmExecCache.get(this.wasmExecUrl);
    if (!shimCode) {
      const shim = await fetch(this.wasmExecUrl);
      if (!shim.ok) {
        throw new Error(`Failed to fetch wasm_exec.js from ${this.wasmExecUrl}`);
      }
      shimCode = await shim.text();

      // Verify hash if provided
      if (this.wasmExecHash) {
        this.verifyHash(shimCode, this.wasmExecHash, 'wasm_exec.js');
      }

      DavinciCSP.wasmExecCache.set(this.wasmExecUrl, shimCode);
    }
    new Function(shimCode)(); // registers globalThis.Go

    if (typeof globalThis.Go !== 'function') {
      throw new Error('Global `Go` constructor not found after loading wasm_exec.js');
    }
    this.go = new globalThis.Go();

    // 2) Fetch & instantiate your Go‐compiled WASM (with caching and hash verification)
    let bytes = DavinciCSP.wasmBinaryCache.get(this.wasmUrl);
    if (!bytes) {
      const resp = await fetch(this.wasmUrl);
      if (!resp.ok) {
        throw new Error(`Failed to fetch davinci_crypto.wasm from ${this.wasmUrl}`);
      }
      bytes = await resp.arrayBuffer();

      // Verify hash if provided
      if (this.wasmHash) {
        this.verifyHash(bytes, this.wasmHash, 'davinci_crypto.wasm');
      }

      DavinciCSP.wasmBinaryCache.set(this.wasmUrl, bytes);
    }
    const { instance } = await WebAssembly.instantiate(bytes, this.go.importObject);

    // 3) Start the Go scheduler (it sets up DavinciCrypto)
    this.go.run(instance).catch(() => {
      /* swallow the exit exception */
    });

    // 4) Wait for the global DavinciCrypto helper to appear
    const deadline = Date.now() + this.initTimeoutMs;
    while (Date.now() < deadline && !globalThis.DavinciCrypto) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!globalThis.DavinciCrypto) {
      throw new Error('`DavinciCrypto` not initialized within timeout');
    }

    this.initialized = true;
  }

  /**
   * Generate a CSP (Credential Service Provider) signature for census proof.
   * @param censusOrigin - The census origin type (e.g., CensusOrigin.CSP)
   * @param privKey - The private key in hex format
   * @param processId - The process ID in hex format
   * @param address - The address in hex format
   * @param weight - The vote weight as a decimal string
   * @returns The CSP proof as a parsed JSON object
   * @throws if called before `await init()`, or if Go returns an error
   */
  async cspSign(
    censusOrigin: CensusOrigin,
    privKey: string,
    processId: string,
    address: string,
    weight: string
  ): Promise<CSPSignOutput> {
    if (!this.initialized) {
      throw new Error('DavinciCSP not initialized — call `await init()` first');
    }

    const raw = globalThis.DavinciCrypto.cspSign(censusOrigin, privKey, processId, address, weight);

    if (raw.error) {
      throw new Error(`Go/WASM cspSign error: ${raw.error}`);
    }
    if (!raw.data) {
      throw new Error('Go/WASM cspSign returned no data');
    }

    return raw.data;
  }

  /**
   * Verify a CSP (Credential Service Provider) proof.
   * @param censusOrigin - The census origin type (e.g., CensusOrigin.CSP)
   * @param root - The census root
   * @param address - The address
   * @param weight - The vote weight as a decimal string
   * @param processId - The process ID
   * @param publicKey - The public key
   * @param signature - The signature
   * @returns The verification result
   * @throws if called before `await init()`, or if Go returns an error
   */
  async cspVerify(
    censusOrigin: CensusOrigin,
    root: string,
    address: string,
    weight: string,
    processId: string,
    publicKey: string,
    signature: string
  ): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('DavinciCSP not initialized — call `await init()` first');
    }

    // Create the CSP proof object and stringify it for the WASM call
    const cspProof = {
      censusOrigin,
      root,
      address,
      weight,
      processId,
      publicKey,
      signature,
    };

    const raw = globalThis.DavinciCrypto.cspVerify(JSON.stringify(cspProof));

    if (raw.error) {
      throw new Error(`Go/WASM cspVerify error: ${raw.error}`);
    }
    if (!raw.data) {
      throw new Error('Go/WASM cspVerify returned no data');
    }

    return raw.data;
  }

  /**
   * Generate a CSP (Credential Service Provider) census root.
   * @param censusOrigin - The census origin type (e.g., CensusOrigin.CSP)
   * @param privKey - The private key in hex format
   * @returns The census root as a hexadecimal string
   * @throws if called before `await init()`, or if Go returns an error
   */
  async cspCensusRoot(censusOrigin: CensusOrigin, privKey: string): Promise<string> {
    if (!this.initialized) {
      throw new Error('DavinciCSP not initialized — call `await init()` first');
    }

    const raw = globalThis.DavinciCrypto.cspCensusRoot(censusOrigin, privKey);

    if (raw.error) {
      throw new Error(`Go/WASM cspCensusRoot error: ${raw.error}`);
    }
    if (!raw.data) {
      throw new Error('Go/WASM cspCensusRoot returned no data');
    }

    return raw.data.root;
  }
}
