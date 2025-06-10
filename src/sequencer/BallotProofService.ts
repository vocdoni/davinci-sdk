import {ProofInputs} from "./CircomProofService";

export interface BallotProofMode {
    maxCount: number;
    forceUniqueness: boolean;
    maxValue: string;
    minValue: string;
    maxTotalCost: string;
    minTotalCost: string;
    costExponent: number;
    costFromWeight: boolean;
}

export interface BallotProofInputs {
    address: string;
    processID: string;
    secret: string;
    encryptionKey: [string, string];
    k: string;
    weight: string;
    fieldValues: string[];
    ballotMode: BallotProofMode;
}

export interface BallotProofCiphertext {
    c1: [string, string];
    c2: [string, string];
}

export interface BallotProofOutput {
    processID: string;
    address: string;
    commitment: string;
    nullifier: string;
    ballot: {
        curveType: string;
        ciphertexts: BallotProofCiphertext[];
    };
    ballotInputHash: string;
    voteID: string;
    circomInputs: ProofInputs;
}

// internal shapes returned by the Go runtime
interface RawResult { error?: string; data?: string; }
interface GoBallotProofWasm {
    proofInputs(inputJson: string): RawResult;
}

declare global {
    var Go: new () => { importObject: Record<string, any>; run(instance: WebAssembly.Instance): Promise<void> };
    var BallotProofWasm: GoBallotProofWasm;
}

export interface BallotProofOptions {
    /** URL to wasm_exec.js */
    wasmExecUrl: string;
    /** URL to the compiled ballotproof.wasm */
    wasmUrl: string;
    /** How long (ms) to wait for the Go runtime to attach BallotProofWasm */
    initTimeoutMs?: number;
}

export class BallotProof {
    private go!: InstanceType<typeof Go>;
    private initialized = false;
    private readonly wasmExecUrl: string;
    private readonly wasmUrl: string;
    private readonly initTimeoutMs: number;

    // Cache for wasm files
    private static wasmExecCache = new Map<string, string>();
    private static wasmBinaryCache = new Map<string, ArrayBuffer>();

    constructor(opts: BallotProofOptions) {
        const { wasmExecUrl, wasmUrl, initTimeoutMs } = opts;

        if (!wasmExecUrl) throw new Error("`wasmExecUrl` is required");
        if (!wasmUrl)     throw new Error("`wasmUrl` is required");

        this.wasmExecUrl   = wasmExecUrl;
        this.wasmUrl       = wasmUrl;
        this.initTimeoutMs = initTimeoutMs ?? 5_000;
    }

    /**
     * Must be awaited before calling `proofInputs()`.
     * Safe to call multiple times.
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        // 1) Fetch & eval Go runtime shim (with caching)
        let shimCode = BallotProof.wasmExecCache.get(this.wasmExecUrl);
        if (!shimCode) {
            const shim = await fetch(this.wasmExecUrl);
            if (!shim.ok) {
                throw new Error(`Failed to fetch wasm_exec.js from ${this.wasmExecUrl}`);
            }
            shimCode = await shim.text();
            BallotProof.wasmExecCache.set(this.wasmExecUrl, shimCode);
        }
        new Function(shimCode)();  // registers globalThis.Go

        if (typeof globalThis.Go !== "function") {
            throw new Error("Global `Go` constructor not found after loading wasm_exec.js");
        }
        this.go = new globalThis.Go();

        // 2) Fetch & instantiate your Go‐compiled WASM (with caching)
        let bytes = BallotProof.wasmBinaryCache.get(this.wasmUrl);
        if (!bytes) {
            const resp = await fetch(this.wasmUrl);
            if (!resp.ok) {
                throw new Error(`Failed to fetch ballotproof.wasm from ${this.wasmUrl}`);
            }
            bytes = await resp.arrayBuffer();
            BallotProof.wasmBinaryCache.set(this.wasmUrl, bytes);
        }
        const { instance } = await WebAssembly.instantiate(bytes, this.go.importObject);

        // 3) Start the Go scheduler (it sets up BallotProofWasm)
        try {
            await this.go.run(instance);
        } catch {
            // swallow the exit exception
        }

        // 4) Wait for the global BallotProofWasm helper to appear
        const deadline = Date.now() + this.initTimeoutMs;
        while (Date.now() < deadline && !globalThis.BallotProofWasm) {
            await new Promise((r) => setTimeout(r, 50));
        }
        if (!globalThis.BallotProofWasm) {
            throw new Error("`BallotProofWasm` not initialized within timeout");
        }

        this.initialized = true;
    }

    /**
     * Convert your inputs into JSON, hand off to Go/WASM, then parse & return.
     * @throws if called before `await init()`, or if Go returns an error
     */
    async proofInputs(inputs: BallotProofInputs): Promise<BallotProofOutput> {
        if (!this.initialized) {
            throw new Error("BallotProof not initialized — call `await init()` first");
        }

        const raw = (globalThis.BallotProofWasm as GoBallotProofWasm)
            .proofInputs(JSON.stringify(inputs));

        if (raw.error) {
            throw new Error(`Go/WASM proofInputs error: ${raw.error}`);
        }
        if (!raw.data) {
            throw new Error("Go/WASM proofInputs returned no data");
        }

        return JSON.parse(raw.data) as BallotProofOutput;
    }
}
