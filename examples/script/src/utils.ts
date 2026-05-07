import { config } from 'dotenv';
import { Wallet } from 'ethers';
import chalk from 'chalk';
import * as readline from 'readline';
import { CensusOrigin } from '../../../src';

config();

// ────────────────────────────────────────────────────────────
//   CONFIG / CONSTANTS
// ────────────────────────────────────────────────────────────
if (!process.env.SEQUENCER_API_URL)
  throw new Error('SEQUENCER_API_URL environment variable is required');
if (!process.env.CENSUS_API_URL) throw new Error('CENSUS_API_URL environment variable is required');
if (!process.env.RPC_URL) throw new Error('RPC_URL environment variable is required');
if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY environment variable is required');

export const SEQUENCER_API_URL = process.env.SEQUENCER_API_URL;
export const CENSUS_API_URL = process.env.CENSUS_API_URL;
export const RPC_URL = process.env.RPC_URL;
export const PRIVATE_KEY = process.env.PRIVATE_KEY;

// CSP private key - use from env or generate random one
export const CSP_PRIVATE_KEY = process.env.CSP_PRIVATE_KEY || Wallet.createRandom().privateKey;

// ────────────────────────────────────────────────────────────
//   LOGGING HELPERS
// ────────────────────────────────────────────────────────────
export const info = (msg: string) => console.log(chalk.cyan('ℹ'), msg);
export const success = (msg: string) => console.log(chalk.green('✔'), msg);
export const step = (n: number, msg: string) =>
  console.log(chalk.yellow.bold(`\n[Step ${n}]`), chalk.white(msg));

// ────────────────────────────────────────────────────────────
//   TYPES
// ────────────────────────────────────────────────────────────
export interface UserConfig {
  numParticipants: number;
  censusType: CensusOrigin;
  useWeights: boolean;
  prebuiltCensusRoot?: string;
  prebuiltCensusUri?: string;
  prebuiltCensusSize?: number;
}

export type TestParticipant = {
  address: string;
  weight: string;
  privateKey: string;
};

type Snapshot = {
  snapshotDate: string;
  censusRoot: string;
  participantCount: number;
  queryName: string;
};

// ────────────────────────────────────────────────────────────
//   USER INPUT HELPERS
// ────────────────────────────────────────────────────────────
function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => {
      resolve(answer.trim());
    });
  });
}

export async function getUserConfiguration(): Promise<UserConfig> {
  const rl = createReadlineInterface();

  console.log(chalk.bold.cyan('\n📋 Configuration Setup\n'));

  // Ask for census type
  console.log(chalk.cyan('\nCensus Type Options:'));
  console.log('1. MerkleTree (default) - Traditional Merkle tree-based census');
  console.log('2. CSP - Credential Service Provider census');
  console.log('3. Prebuilt (from census service) - Use an existing published census');

  const censusTypeAnswer = await askQuestion(
    rl,
    chalk.yellow('Which census type do you want to use? (1, 2, or 3, default: 1): ')
  );

  let censusType: CensusOrigin;
  let prebuiltCensusRoot: string | undefined;
  let prebuiltCensusUri: string | undefined;
  let prebuiltCensusSize: number | undefined;
  let numParticipants = 5;
  if (censusTypeAnswer === '2') {
    censusType = CensusOrigin.CSP;
    console.log(chalk.green('✓ Selected: CSP Census'));
  } else if (censusTypeAnswer === '3') {
    censusType = CensusOrigin.OffchainStatic;
    console.log(chalk.green('✓ Selected: Prebuilt Census (Census Service)'));

    const snapshotsResponse = await fetch(`${CENSUS_API_URL}/snapshots?page=1&pageSize=10`);
    if (!snapshotsResponse.ok) {
      rl.close();
      throw new Error(`Unable to load snapshots from census service: HTTP ${snapshotsResponse.status}`);
    }
    const snapshotsPayload = await snapshotsResponse.json();
    const snapshots = (snapshotsPayload.snapshots || []) as Snapshot[];

    if (snapshots.length === 0) {
      rl.close();
      throw new Error('No prebuilt census snapshots found in census service');
    }

    console.log(chalk.cyan('\nAvailable prebuilt censuses:'));
    snapshots.forEach((snapshot, index) => {
      console.log(
        `${index + 1}. ${snapshot.queryName} | participants: ${snapshot.participantCount} | root: ${snapshot.censusRoot.slice(0, 18)}...`
      );
    });

    const selectionAnswer = await askQuestion(
      rl,
      chalk.yellow(`Select a prebuilt census (1-${snapshots.length}, default: 1): `)
    );
    const selection = selectionAnswer ? parseInt(selectionAnswer, 10) : 1;
    const selected = snapshots[selection - 1];

    if (!selected) {
      rl.close();
      throw new Error(`Invalid prebuilt census selection: ${selectionAnswer}`);
    }

    if (!selected.censusRoot) {
      rl.close();
      throw new Error('Selected prebuilt census does not include a root');
    }

    prebuiltCensusRoot = selected.censusRoot;
    prebuiltCensusUri = `${CENSUS_API_URL}/censuses/${selected.censusRoot}`;
    prebuiltCensusSize = selected.participantCount;
    console.log(chalk.green(`✓ Selected prebuilt census: ${selected.queryName}`));
  } else {
    censusType = CensusOrigin.OffchainStatic;
    console.log(chalk.green('✓ Selected: MerkleTree Census'));
  }

  // Ask for number of participants only for non-prebuilt census types
  if (!prebuiltCensusRoot) {
    const numParticipantsAnswer = await askQuestion(
      rl,
      chalk.yellow('How many participants do you want to create? (default: 5): ')
    );
    numParticipants = numParticipantsAnswer ? parseInt(numParticipantsAnswer, 10) : 5;

    if (isNaN(numParticipants) || numParticipants < 1) {
      console.log(chalk.red('Invalid number of participants. Using default: 5'));
    }
  }

  // Ask about weight usage
  const useWeightsAnswer = await askQuestion(
    rl,
    chalk.yellow('\nDo you want to use weighted voting? (y/N, default: N): ')
  );

  const useWeights =
    useWeightsAnswer.toLowerCase() === 'y' || useWeightsAnswer.toLowerCase() === 'yes';
  if (useWeights) {
    console.log(
      chalk.green('✓ Weighted voting enabled - votes will be multiplied by participant weight')
    );
  } else {
    console.log(chalk.green('✓ Standard voting - all votes count equally'));
  }

  rl.close();

  return {
    numParticipants: Math.max(1, numParticipants || 5),
    censusType,
    useWeights,
    prebuiltCensusRoot,
    prebuiltCensusUri,
    prebuiltCensusSize,
  };
}

// ────────────────────────────────────────────────────────────
//   PARTICIPANTS GENERATOR
// ────────────────────────────────────────────────────────────
export function generateTestParticipants(count: number = 5): TestParticipant[] {
  const participants: TestParticipant[] = [];

  for (let i = 0; i < count; i++) {
    const wallet = Wallet.createRandom();
    participants.push({
      address: wallet.address,
      weight: ((i + 1) * 10).toString(), // Weight: 10, 20, 30, etc.
      privateKey: wallet.privateKey,
    });
  }

  return participants;
}
