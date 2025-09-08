import { BallotMode } from "../core/types";
import { ProofInputs } from "./CircomProofService";
import { CensusOrigin } from "../census/types";
import { sha256 } from "ethers";

export interface DavinciCryptoInputs {
    address: string;
    processID: string;
    encryptionKey: [string, string];
    k: string;
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
    processId: string;
    publicKey: string;
    signature: string;
}

// internal shapes returned by the Go runtime
interface RawResult { error?: string; data?: string; }
interface GoDavinciCryptoWasm {
    proofInputs(inputJson: string): RawResult;
    cspSign(censusOrigin: number, privKey: string, processId: string, address: string): RawResult;
    cspVerify(cspProof: string): RawResult;
    cspCensusRoot(censusOrigin: number, privKey: string): RawResult;
}

declare global {
    var Go: new () => { importObject: Record<string, any>; run(instance: WebAssembly.Instance): Promise<void> };
    var DavinciCrypto: GoDavinciCryptoWasm;
}

export interface DavinciCryptoOptions {
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

export class DavinciCrypto {
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

    constructor(opts: DavinciCryptoOptions) {
        const { wasmExecUrl, wasmUrl, initTimeoutMs, wasmExecHash, wasmHash } = opts;

        if (!wasmExecUrl) throw new Error("`wasmExecUrl` is required");
        if (!wasmUrl)     throw new Error("`wasmUrl` is required");

        this.wasmExecUrl   = wasmExecUrl;
        this.wasmUrl       = wasmUrl;
        this.initTimeoutMs = initTimeoutMs ?? 5_000;
        this.wasmExecHash  = wasmExecHash;
        this.wasmHash      = wasmHash;
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
     * Must be awaited before calling `proofInputs()`.
     * Safe to call multiple times.
     */
    async init(): Promise<void> {
        if (this.initialized) return;

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
        new Function(shimCode)();  // registers globalThis.Go

        if (typeof globalThis.Go !== "function") {
            throw new Error("Global `Go` constructor not found after loading wasm_exec.js");
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
        this.go.run(instance).catch(() => { /* swallow the exit exception */ });

        // 4) Wait for the global DavinciCrypto helper to appear
        const deadline = Date.now() + this.initTimeoutMs;
        while (Date.now() < deadline && !globalThis.DavinciCrypto) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (!globalThis.DavinciCrypto) {
            throw new Error("`DavinciCrypto` not initialized within timeout");
        }

        this.initialized = true;
    }

    /**
     * Convert your inputs into JSON, hand off to Go/WASM, then parse & return.
     * @throws if called before `await init()`, or if Go returns an error
     */
    async proofInputs(inputs: DavinciCryptoInputs): Promise<DavinciCryptoOutput> {
        if (!this.initialized) {
            throw new Error("DavinciCrypto not initialized — call `await init()` first");
        }

        const raw = (globalThis.DavinciCrypto as GoDavinciCryptoWasm)
            .proofInputs(JSON.stringify(inputs));

        if (raw.error) {
            throw new Error(`Go/WASM proofInputs error: ${raw.error}`);
        }
        if (!raw.data) {
            throw new Error("Go/WASM proofInputs returned no data");
        }

        return JSON.parse(raw.data) as DavinciCryptoOutput;
    }

    /**
     * Generate a CSP (Credential Service Provider) signature for census proof.
     * @param censusOrigin - The census origin type (e.g., CensusOrigin.CensusOriginCSP)
     * @param privKey - The private key in hex format
     * @param processId - The process ID in hex format
     * @param address - The address in hex format
     * @returns The CSP proof as a parsed JSON object
     * @throws if called before `await init()`, or if Go returns an error
     */
    async cspSign(censusOrigin: CensusOrigin, privKey: string, processId: string, address: string): Promise<CSPSignOutput> {
        if (!this.initialized) {
            throw new Error("DavinciCrypto not initialized — call `await init()` first");
        }

        const raw = (globalThis.DavinciCrypto as GoDavinciCryptoWasm)
            .cspSign(censusOrigin, privKey, processId, address);

        if (raw.error) {
            throw new Error(`Go/WASM cspSign error: ${raw.error}`);
        }
        if (!raw.data) {
            throw new Error("Go/WASM cspSign returned no data");
        }

        return JSON.parse(raw.data) as CSPSignOutput;
    }

    /**
     * Verify a CSP (Credential Service Provider) proof.
     * @param censusOrigin - The census origin type (e.g., CensusOrigin.CensusOriginCSP)
     * @param root - The census root
     * @param address - The address
     * @param processId - The process ID
     * @param publicKey - The public key
     * @param signature - The signature
     * @returns The verification result
     * @throws if called before `await init()`, or if Go returns an error
     */
    async cspVerify(censusOrigin: CensusOrigin, root: string, address: string, processId: string, publicKey: string, signature: string): Promise<boolean> {
        if (!this.initialized) {
            throw new Error("DavinciCrypto not initialized — call `await init()` first");
        }

        // Create the CSP proof object and stringify it for the WASM call
        const cspProof = {
            censusOrigin,
            root,
            address,
            processId,
            publicKey,
            signature
        };

        const raw = (globalThis.DavinciCrypto as GoDavinciCryptoWasm)
            .cspVerify(JSON.stringify(cspProof));

        if (raw.error) {
            throw new Error(`Go/WASM cspVerify error: ${raw.error}`);
        }
        if (!raw.data) {
            throw new Error("Go/WASM cspVerify returned no data");
        }

        // Parse the result - it should be a boolean or string representation
        try {
            const result = JSON.parse(raw.data);
            return Boolean(result);
        } catch {
            // If it's not JSON, treat as string and check for truthy values
            return raw.data.toLowerCase() === 'true';
        }
    }

    /**
     * Generate a CSP (Credential Service Provider) census root.
     * @param censusOrigin - The census origin type (e.g., CensusOrigin.CensusOriginCSP)
     * @param privKey - The private key in hex format
     * @returns The census root as a hexadecimal string
     * @throws if called before `await init()`, or if Go returns an error
     */
    async cspCensusRoot(censusOrigin: CensusOrigin, privKey: string): Promise<string> {
        if (!this.initialized) {
            throw new Error("DavinciCrypto not initialized — call `await init()` first");
        }

        const raw = (globalThis.DavinciCrypto as GoDavinciCryptoWasm)
            .cspCensusRoot(censusOrigin, privKey);

        if (raw.error) {
            throw new Error(`Go/WASM cspCensusRoot error: ${raw.error}`);
        }
        if (!raw.data) {
            throw new Error("Go/WASM cspCensusRoot returned no data");
        }

        return JSON.parse(raw.data) as string;
    }
}
