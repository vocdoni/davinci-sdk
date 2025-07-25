// src/ProofGenerator.ts
import { groth16 } from "snarkjs";

export interface ProofInputs {
    fields: string[];
    max_count: string;
    force_uniqueness: string;
    max_value: string;
    min_value: string;
    max_total_cost: string;
    min_total_cost: string;
    cost_exp: string;
    cost_from_weight: string;
    address: string;
    weight: string;
    process_id: string;
    pk: [string, string];
    k: string;
    cipherfields: string[];
    vote_id: string;
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
}

export class CircomProof {
    private readonly wasmUrl?: string;
    private readonly zkeyUrl?: string;
    private readonly vkeyUrl?: string;

    // simple in-memory cache keyed by URL
    private wasmCache = new Map<string, Uint8Array>();
    private zkeyCache = new Map<string, Uint8Array>();
    private vkeyCache = new Map<string, any>();

    constructor(opts: CircomProofOptions = {}) {
        this.wasmUrl = opts.wasmUrl;
        this.zkeyUrl = opts.zkeyUrl;
        this.vkeyUrl = opts.vkeyUrl;
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
        if (!wasmUrl) throw new Error("`wasmUrl` is required to generate a proof");
        if (!zkeyUrl) throw new Error("`zkeyUrl` is required to generate a proof");

        // fetch+cache .wasm
        let wasmBin = this.wasmCache.get(wasmUrl);
        if (!wasmBin) {
            const r = await fetch(wasmUrl);
            if (!r.ok) throw new Error(`Failed to fetch wasm at ${wasmUrl}: ${r.status}`);
            const buf = await r.arrayBuffer();
            wasmBin = new Uint8Array(buf);
            this.wasmCache.set(wasmUrl, wasmBin);
        }

        // fetch+cache .zkey
        let zkeyBin = this.zkeyCache.get(zkeyUrl);
        if (!zkeyBin) {
            const r = await fetch(zkeyUrl);
            if (!r.ok) throw new Error(`Failed to fetch zkey at ${zkeyUrl}: ${r.status}`);
            const buf = await r.arrayBuffer();
            zkeyBin = new Uint8Array(buf);
            this.zkeyCache.set(zkeyUrl, zkeyBin);
        }

        const { proof, publicSignals } = await groth16.fullProve(
            inputs,
            wasmBin,
            zkeyBin
        );
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
        if (!vkeyUrl) throw new Error("`vkeyUrl` is required to verify a proof");

        // fetch+cache vkey JSON
        let vk = this.vkeyCache.get(vkeyUrl);
        if (!vk) {
            const r = await fetch(vkeyUrl);
            if (!r.ok) throw new Error(`Failed to fetch vkey at ${vkeyUrl}: ${r.status}`);
            vk = await r.json();
            this.vkeyCache.set(vkeyUrl, vk);
        }

        return groth16.verify(vk, publicSignals, proof);
    }
}
