import { ProofInputs } from '../sequencer/CircomProofService';

// Re-export types from BallotBuilder to avoid duplication
export type { BallotConfig, BallotInputs, SequencerProcessData } from './BallotBuilder';

export interface Ciphertext {
  c1: [string, string];
  c2: [string, string];
}

export interface BallotInputsOutput {
  processId: string;
  address: string;
  ballot: {
    curveType: string;
    ciphertexts: Ciphertext[];
  };
  ballotInputsHash: string;
  voteId: string;
  circomInputs: ProofInputs;
}
