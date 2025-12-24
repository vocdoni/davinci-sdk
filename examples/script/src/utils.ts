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
}

export type TestParticipant = {
  address: string;
  weight: string;
  privateKey: string;
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

  // Ask for number of participants
  const numParticipantsAnswer = await askQuestion(
    rl,
    chalk.yellow('How many participants do you want to create? (default: 5): ')
  );
  const numParticipants = numParticipantsAnswer ? parseInt(numParticipantsAnswer, 10) : 5;

  if (isNaN(numParticipants) || numParticipants < 1) {
    console.log(chalk.red('Invalid number of participants. Using default: 5'));
  }

  // Ask for census type
  console.log(chalk.cyan('\nCensus Type Options:'));
  console.log('1. MerkleTree (default) - Traditional Merkle tree-based census');
  console.log('2. CSP - Credential Service Provider census');

  const censusTypeAnswer = await askQuestion(
    rl,
    chalk.yellow('Which census type do you want to use? (1 or 2, default: 1): ')
  );

  let censusType: CensusOrigin;
  if (censusTypeAnswer === '2') {
    censusType = CensusOrigin.CSP;
    console.log(chalk.green('✓ Selected: CSP Census'));
  } else {
    censusType = CensusOrigin.OffchainStatic;
    console.log(chalk.green('✓ Selected: MerkleTree Census'));
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
