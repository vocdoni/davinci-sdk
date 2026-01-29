import { BallotMode } from '../core/types';
import { ProofInputs } from './CircomProofService';
import { CensusOrigin } from '../census/types';
import { sha256 } from 'ethers';
import { BallotBuilder, BallotConfig } from './crypto';

export interface DavinciCryptoInputs {
  address: string;
  processID: string;
  encryptionKey: [string, string];
  k?: string;
  weight: string;
  fieldValues: string[];
  ballotMode: BallotMode;
}

export interface DavinciCryptoCiphertext {
  c1: [string, string];
  c2: [string, string];
}

export interface DavinciCryptoOutput {
  processId: string;
  address: string;
  ballot: {
    curveType: string;
    ciphertexts: DavinciCryptoCiphertext[];
  };
  ballotInputsHash: string;
  voteId: string;
  circomInputs: ProofInputs;
}

export interface CSPSignOutput {
  censusOrigin: CensusOrigin;
  root: string;
  address: string;
  weight: string;
  processId: string;
  publicKey: string;
  signature: string;
}

// internal shapes returned by the Go runtime (only used for CSP functions now)
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

declare global {
  var Go: new () => {
    importObject: Record<string, any>;
    run(instance: WebAssembly.Instance): Promise<void>;
  };
  var DavinciCrypto: GoDavinciCryptoWasm;
}

export interface DavinciCryptoOptions {
  /** URL to wasm_exec.js (only needed for CSP functions) */
  wasmExecUrl?: string;
  /** URL to the compiled davinci_crypto.wasm (only needed for CSP functions) */
  wasmUrl?: string;
  /** How long (ms) to wait for the Go runtime to attach DavinciCrypto */
  initTimeoutMs?: number;
  /** Optional SHA-256 hash to verify wasm_exec.js integrity */
  wasmExecHash?: string;
  /** Optional SHA-256 hash to verify davinci_crypto.wasm integrity */
  wasmHash?: string;
}

export class DavinciCrypto {
  private go?: InstanceType<typeof Go>;
  private wasmInitialized = false;
  private ballotBuilder?: BallotBuilder;
  private readonly wasmExecUrl?: string;
  private readonly wasmUrl?: string;
  private readonly initTimeoutMs: number;
  private readonly wasmExecHash?: string;
  private readonly wasmHash?: string;

  // Cache for wasm files (only used for CSP)
  private static wasmExecCache = new Map<string, string>();
  private static wasmBinaryCache = new Map<string, ArrayBuffer>();

  constructor(opts: DavinciCryptoOptions = {}) {
    const { wasmExecUrl, wasmUrl, initTimeoutMs, wasmExecHash, wasmHash } = opts;

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
   * Initialize the BallotBuilder (TypeScript implementation)
   * This is called automatically by proofInputs if not already initialized
   */
  private async initBallotBuilder(): Promise<void> {
    if (!this.ballotBuilder) {
      this.ballotBuilder = await BallotBuilder.build();
    }
  }

  /**
   * Initialize WASM for CSP functions only
   * Must be awaited before calling CSP methods (cspSign, cspVerify, cspCensusRoot).
   * Safe to call multiple times.
   */
  async initWasm(): Promise<void> {
    if (this.wasmInitialized) return;

    if (!this.wasmExecUrl || !this.wasmUrl) {
      throw new Error('WASM URLs are required for CSP functions. Provide wasmExecUrl and wasmUrl.');
    }

    // 1) Fetch & eval Go runtime shim (with caching and hash verification)
    let shimCode = DavinciCrypto.wasmExecCache.get(this.wasmExecUrl);
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

      DavinciCrypto.wasmExecCache.set(this.wasmExecUrl, shimCode);
    }
    new Function(shimCode)(); // registers globalThis.Go

    if (typeof globalThis.Go !== 'function') {
      throw new Error('Global `Go` constructor not found after loading wasm_exec.js');
    }
    this.go = new globalThis.Go();

    // 2) Fetch & instantiate your Go‐compiled WASM (with caching and hash verification)
    let bytes = DavinciCrypto.wasmBinaryCache.get(this.wasmUrl);
    if (!bytes) {
      const resp = await fetch(this.wasmUrl);
      if (!resp.ok) {
        throw new Error(`Failed to fetch ballotproof.wasm from ${this.wasmUrl}`);
      }
      bytes = await resp.arrayBuffer();

      // Verify hash if provided
      if (this.wasmHash) {
        this.verifyHash(bytes, this.wasmHash, 'davinci_crypto.wasm');
      }

      DavinciCrypto.wasmBinaryCache.set(this.wasmUrl, bytes);
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

    this.wasmInitialized = true;
  }

  /**
   * Generate proof inputs using the TypeScript implementation (no WASM needed)
   * @throws if any error occurs during ballot generation
   */
  async proofInputs(inputs: DavinciCryptoInputs): Promise<DavinciCryptoOutput> {
    // Initialize BallotBuilder if not already done
    await this.initBallotBuilder();

    const builder = this.ballotBuilder!;

    // Parse encryption key - keep as strings, builder will handle conversion
    const pubKey = [inputs.encryptionKey[0], inputs.encryptionKey[1]];

    // Generate or use provided k
    const k = inputs.k || builder.randomK();

    // Parse field values to numbers
    const fields = inputs.fieldValues.map(v => parseInt(v, 10));

    // Create ballot config from ballotMode
    const config: BallotConfig = {
      numFields: inputs.ballotMode.numFields,
      uniqueValues: inputs.ballotMode.uniqueValues ? 1 : 0,
      maxValue: parseInt(inputs.ballotMode.maxValue, 10),
      minValue: parseInt(inputs.ballotMode.minValue, 10),
      maxValueSum: parseInt(inputs.ballotMode.maxValueSum, 10),
      minValueSum: parseInt(inputs.ballotMode.minValueSum, 10),
      costExponent: inputs.ballotMode.costExponent,
      costFromWeight: inputs.ballotMode.costFromWeight ? 1 : 0,
    };

    // Prepare inputs for builder
    const processId = inputs.processID.startsWith('0x')
      ? BigInt(inputs.processID).toString()
      : BigInt('0x' + inputs.processID).toString();

    const address = inputs.address.startsWith('0x')
      ? BigInt(inputs.address).toString()
      : BigInt('0x' + inputs.address).toString();

    const weight = parseInt(inputs.weight, 10);

    // Generate ballot inputs using BallotBuilder
    const ballotInputs = builder.generateInputs(
      fields,
      weight,
      pubKey,
      processId,
      address,
      k,
      config,
      8 // circuit capacity
    );

    // Convert to DavinciCryptoOutput format
    const ciphertexts: DavinciCryptoCiphertext[] = ballotInputs.cipherfields.map(cf => ({
      c1: [cf[0][0], cf[0][1]] as [string, string],
      c2: [cf[1][0], cf[1][1]] as [string, string],
    }));

    // Build circom inputs (convert types to match ProofInputs interface)
    const circomInputs: ProofInputs = {
      process_id: ballotInputs.process_id,
      num_fields: ballotInputs.num_fields.toString(),
      unique_values: ballotInputs.unique_values.toString(),
      max_value: ballotInputs.max_value.toString(),
      min_value: ballotInputs.min_value.toString(),
      max_value_sum: ballotInputs.max_value_sum.toString(),
      min_value_sum: ballotInputs.min_value_sum.toString(),
      cost_exponent: ballotInputs.cost_exponent.toString(),
      cost_from_weight: ballotInputs.cost_from_weight.toString(),
      encryption_pubkey: [ballotInputs.encryption_pubkey[0], ballotInputs.encryption_pubkey[1]],
      address: ballotInputs.address,
      vote_id: ballotInputs.vote_id,
      cipherfields: ballotInputs.cipherfields,
      weight: ballotInputs.weight.toString(),
      fields: ballotInputs.fields.map(f => f.toString()),
      k: ballotInputs.k,
      inputs_hash: ballotInputs.inputs_hash,
    };

    return {
      processId: inputs.processID,
      address: inputs.address,
      ballot: {
        curveType: 'bjj_iden3',
        ciphertexts,
      },
      ballotInputsHash: ballotInputs.inputs_hash,
      voteId: ballotInputs.vote_id,
      circomInputs,
    };
  }

  /**
   * Generate a CSP (Credential Service Provider) signature for census proof.
   * Requires WASM to be initialized first via initWasm()
   * @param censusOrigin - The census origin type (e.g., CensusOrigin.CensusOriginCSP)
   * @param privKey - The private key in hex format
   * @param processId - The process ID in hex format
   * @param address - The address in hex format
   * @param weight - The vote weight as a decimal string
   * @returns The CSP proof as a parsed JSON object
   * @throws if called before `await initWasm()`, or if Go returns an error
   */
  async cspSign(
    censusOrigin: CensusOrigin,
    privKey: string,
    processId: string,
    address: string,
    weight: string
  ): Promise<CSPSignOutput> {
    if (!this.wasmInitialized) {
      throw new Error('WASM not initialized for CSP functions — call `await initWasm()` first');
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
   * Requires WASM to be initialized first via initWasm()
   * @param censusOrigin - The census origin type (e.g., CensusOrigin.CensusOriginCSP)
   * @param root - The census root
   * @param address - The address
   * @param weight - The vote weight as a decimal string
   * @param processId - The process ID
   * @param publicKey - The public key
   * @param signature - The signature
   * @returns The verification result
   * @throws if called before `await initWasm()`, or if Go returns an error
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
    if (!this.wasmInitialized) {
      throw new Error('WASM not initialized for CSP functions — call `await initWasm()` first');
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
   * Requires WASM to be initialized first via initWasm()
   * @param censusOrigin - The census origin type (e.g., CensusOrigin.CensusOriginCSP)
   * @param privKey - The private key in hex format
   * @returns The census root as a hexadecimal string
   * @throws if called before `await initWasm()`, or if Go returns an error
   */
  async cspCensusRoot(censusOrigin: CensusOrigin, privKey: string): Promise<string> {
    if (!this.wasmInitialized) {
      throw new Error('WASM not initialized for CSP functions — call `await initWasm()` first');
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
