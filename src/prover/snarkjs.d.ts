// The snarkjs calls the SDK makes; snarkjs ships no type declarations.
declare module 'snarkjs' {
  /** A Groth16 proof as snarkjs writes it. */
  export interface SnarkjsGroth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  export const groth16: {
    fullProve: (
      input: object,
      wasm: Uint8Array,
      zkey: Uint8Array
    ) => Promise<{ proof: SnarkjsGroth16Proof; publicSignals: string[] }>;
    verify: (vk: object, publicSignals: readonly string[], proof: object) => Promise<boolean>;
  };

  export const zKey: {
    /** The verification key a proving key carries. */
    exportVerificationKey: (zkey: Uint8Array) => Promise<unknown>;
  };
}
