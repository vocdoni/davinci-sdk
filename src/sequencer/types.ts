export interface ProofInputs {
  fields: string[];
  packed_ballot_mode: string;
  address: string;
  weight: string;
  process_id: string;
  vote_id: string;
  encryption_pubkey: [string, string];
  k: string;
  cipherfields: string[][][];
  inputs_hash: string;
}

export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve?: string;
}
