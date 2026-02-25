#!/usr/bin/env ts-node

import chalk from 'chalk';
import { config } from 'dotenv';
import {
  JsonRpcProvider,
  Wallet,
  ContractFactory,
  Contract,
  InterfaceAbi,
  getAddress,
} from 'ethers';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DavinciSDK, OnchainCensus, VoteStatus, TxStatus } from '../../../src';
import { info, success, step, SEQUENCER_API_URL, CENSUS_API_URL, RPC_URL, PRIVATE_KEY } from './utils';

config();

const ONCHAIN_CENSUS_INDEXER_URL = process.env.ONCHAIN_CENSUS_INDEXER_URL;
const ONCHAIN_CENSUS_CONTRACT_ADDRESS = process.env.ONCHAIN_CENSUS_CONTRACT_ADDRESS;
const ONCHAIN_CENSUS_START_BLOCK = process.env.ONCHAIN_CENSUS_START_BLOCK;
const ONCHAIN_CENSUS_CHAIN_ID = process.env.ONCHAIN_CENSUS_CHAIN_ID;

const ONCHAIN_CENSUS_ARTIFACT_PATH = process.env.ONCHAIN_CENSUS_ARTIFACT_PATH;

const ONCHAIN_VOTER_PRIVATE_KEYS = process.env.ONCHAIN_VOTER_PRIVATE_KEYS;
const ONCHAIN_USE_WEIGHTS = process.env.ONCHAIN_USE_WEIGHTS || 'false';
const ONCHAIN_MAX_VOTERS = process.env.ONCHAIN_MAX_VOTERS;
const ONCHAIN_NUM_PARTICIPANTS = process.env.ONCHAIN_NUM_PARTICIPANTS || '5';
const ONCHAIN_CENSUS_EXPIRES_AT = process.env.ONCHAIN_CENSUS_EXPIRES_AT;
const DEFAULT_ONCHAIN_ARTIFACT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'artifacts',
  'StandardOnchainCensus.json'
);

if (!ONCHAIN_CENSUS_INDEXER_URL) {
  throw new Error('ONCHAIN_CENSUS_INDEXER_URL environment variable is required');
}

type OnchainParticipant = {
  address: string;
  privateKey: string;
  weight: number;
};

type Artifact = {
  abi: InterfaceAbi;
  bytecode: string;
};

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

function createSDKInstance(privateKey: string, withProvider: boolean = true): any {
  const signer = withProvider
    ? new Wallet(privateKey, new JsonRpcProvider(RPC_URL))
    : new Wallet(privateKey);
  return {
    signer,
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL,
  };
}

function loadArtifact(path: string): Artifact {
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const abi = artifact.abi;
  const bytecode = artifact.bytecode?.object ?? artifact.bytecode;

  if (!abi || !bytecode) {
    throw new Error(`Invalid artifact at ${path}. Expected abi and bytecode.`);
  }
  return { abi, bytecode };
}

function normalizeIndexerBase(url: string): string {
  return url.replace(/\/+$/, '');
}

function toHttpBase(url: string): string {
  if (url.startsWith('graphql://')) {
    return `https://${url.slice('graphql://'.length).replace(/\/+$/, '')}`;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return normalizeIndexerBase(url);
  }
  return `https://${normalizeIndexerBase(url)}`;
}

function toGraphqlBase(url: string): string {
  if (url.startsWith('graphql://')) {
    return normalizeIndexerBase(url);
  }
  if (url.startsWith('http://')) {
    return `graphql://${url.slice('http://'.length).replace(/\/+$/, '')}`;
  }
  if (url.startsWith('https://')) {
    return `graphql://${url.slice('https://'.length).replace(/\/+$/, '')}`;
  }
  return `graphql://${normalizeIndexerBase(url)}`;
}

function buildCensusUri(indexerBase: string, chainId: bigint, contractAddress: string): string {
  return `${toGraphqlBase(indexerBase)}/${chainId.toString()}/${contractAddress.toLowerCase()}/graphql`;
}

async function startIndexer(
  indexerBase: string,
  chainId: bigint,
  contractAddress: string,
  startBlock: number
): Promise<void> {
  const url = `${toHttpBase(indexerBase)}/contracts`;
  const defaultExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    chainId: Number(chainId),
    address: contractAddress,
    startBlock,
    expiresAt: ONCHAIN_CENSUS_EXPIRES_AT || defaultExpiresAt,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Indexer start failed (${response.status}) ${body}`);
  }
}

async function step1_initializeSDK(): Promise<DavinciSDK> {
  step(1, 'Initialize DavinciSDK');
  const sdk = new DavinciSDK(createSDKInstance(PRIVATE_KEY));
  await sdk.init();
  success('SDK initialized successfully');
  return sdk;
}

async function step2_resolveOnchainCensusContract(
  provider: JsonRpcProvider
): Promise<{ contractAddress: string; startBlock: number; chainId: bigint }> {
  step(2, 'Resolve onchain census contract');

  const network = await provider.getNetwork();
  const chainId = ONCHAIN_CENSUS_CHAIN_ID ? BigInt(ONCHAIN_CENSUS_CHAIN_ID) : network.chainId;
  info(`Using chainId: ${chainId.toString()}`);

  if (ONCHAIN_CENSUS_CONTRACT_ADDRESS) {
    const address = getAddress(ONCHAIN_CENSUS_CONTRACT_ADDRESS);
    const startBlock = ONCHAIN_CENSUS_START_BLOCK ? Number(ONCHAIN_CENSUS_START_BLOCK) : 0;
    success(`Using existing census contract: ${address}`);
    return { contractAddress: address, startBlock, chainId };
  }

  const artifactPath = ONCHAIN_CENSUS_ARTIFACT_PATH || DEFAULT_ONCHAIN_ARTIFACT_PATH;
  if (!existsSync(artifactPath)) {
    throw new Error(
      `Could not find onchain census artifact. Set ONCHAIN_CENSUS_ARTIFACT_PATH or place default artifact at ${DEFAULT_ONCHAIN_ARTIFACT_PATH}`
    );
  }

  if (!ONCHAIN_CENSUS_ARTIFACT_PATH) {
    info(`Using default artifact path: ${artifactPath}`);
  }

  const { abi, bytecode } = loadArtifact(artifactPath);
  const signer = new Wallet(PRIVATE_KEY, provider);
  const factory = new ContractFactory(abi, bytecode, signer);

  info('Deploying standard onchain census contract...');
  const contract = await factory.deploy();

  await contract.waitForDeployment();
  const receipt = await contract.deploymentTransaction()?.wait();
  const contractAddress = getAddress(await contract.getAddress());
  const startBlock = Number(receipt?.blockNumber ?? 0);

  success(`Census contract deployed: ${contractAddress}`);
  info(`Deployment block: ${startBlock}`);

  return { contractAddress, startBlock, chainId };
}

async function step3_startIndexerAndBuildUri(
  chainId: bigint,
  contractAddress: string,
  startBlock: number
): Promise<string> {
  step(3, 'Start indexer and build census URI');

  info(`Starting indexer tracking at block ${startBlock}...`);
  await startIndexer(ONCHAIN_CENSUS_INDEXER_URL!, chainId, contractAddress, startBlock);
  success('Indexer tracking requested');

  const censusUri = buildCensusUri(ONCHAIN_CENSUS_INDEXER_URL!, chainId, contractAddress);
  success(`Using census URI: ${censusUri}`);
  return censusUri;
}

async function step4_loadParticipantsWithOnchainWeight(
  provider: JsonRpcProvider,
  contractAddress: string,
  useWeights: boolean
): Promise<OnchainParticipant[]> {
  step(4, 'Load/create voter wallets and ensure census weights');

  const configuredPrivateKeys = (ONCHAIN_VOTER_PRIVATE_KEYS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  const targetParticipants = Math.max(1, Number(ONCHAIN_NUM_PARTICIPANTS));
  const admin = new Wallet(PRIVATE_KEY, provider);

  const privateKeys: string[] = [...configuredPrivateKeys];
  if (privateKeys.length === 0) {
    info(`No ONCHAIN_VOTER_PRIVATE_KEYS provided. Creating ${targetParticipants} random voters...`);
    for (let i = 0; i < targetParticipants; i++) {
      const w = Wallet.createRandom();
      privateKeys.push(w.privateKey);
      info(`Generated voter ${i + 1}: ${w.address}`);
    }
    info(
      'Add these private keys to ONCHAIN_VOTER_PRIVATE_KEYS if you want to reuse these voters later.'
    );
  } else {
    info(`Using ${privateKeys.length} voter private key(s) from ONCHAIN_VOTER_PRIVATE_KEYS`);
  }

  if (privateKeys.length === 0) {
    throw new Error('No voter private keys available after auto-generation');
  }

  const contract = new Contract(
    contractAddress,
    [
      'function weightOf(address) view returns (uint88)',
      'function setWeight(address account, uint88 newWeight)',
      'function owner() view returns (address)',
    ],
    admin
  );

  let canWriteWeights = false;
  try {
    const owner = await contract.owner();
    canWriteWeights = owner.toLowerCase() === admin.address.toLowerCase();
  } catch {
    canWriteWeights = false;
  }

  const participants: OnchainParticipant[] = [];
  for (let i = 0; i < privateKeys.length; i++) {
    const privateKey = privateKeys[i];
    const wallet = new Wallet(privateKey, provider);
    const address = wallet.address;
    const desiredWeight = useWeights ? i + 1 : 1;

    participants.push({
      address,
      privateKey,
      weight: desiredWeight,
    });
  }

  if (canWriteWeights) {
    info('Contract owner detected. Populating census weights from admin account...');
    const addresses = participants.map(p => p.address);
    const weights = participants.map(p => p.weight);
    try {
      const tx = await contract.setWeights(addresses, weights);
      await tx.wait();
      success(`Census weights updated for ${participants.length} participant(s)`);
    } catch {
      info('Batch setWeights failed, falling back to per-address setWeight...');
      for (const p of participants) {
        const tx = await contract.setWeight(p.address, p.weight);
        await tx.wait();
      }
      success(`Census weights updated for ${participants.length} participant(s)`);
    }
  } else {
    info('Admin is not contract owner. Reusing pre-existing onchain census weights.');
  }

  for (const p of participants) {
    const weight = Number(await contract.weightOf(p.address));
    info(`Address ${p.address} -> onchain weight ${weight}`);
    if (weight <= 0) {
      throw new Error(
        `Address ${p.address} has no onchain weight in census contract (weightOf=0).`
      );
    }
    p.weight = weight;
  }

  success(`Validated ${participants.length} onchain voters`);
  return participants;
}

async function step5_createProcess(
  sdk: DavinciSDK,
  censusUri: string,
  contractAddress: string,
  participants: OnchainParticipant[],
  useWeights: boolean
): Promise<string> {
  step(5, `Create process with OnchainCensus${useWeights ? ' (weighted)' : ''}`);

  const census = new OnchainCensus(contractAddress, censusUri);
  const maxWeight = Math.max(...participants.map(p => p.weight));
  const maxOption = 3;
  const maxValue = useWeights ? maxOption * maxWeight : maxOption;
  const maxValueSum = useWeights ? maxValue * 2 : maxOption * 2;
  const maxVoters = ONCHAIN_MAX_VOTERS ? Number(ONCHAIN_MAX_VOTERS) : participants.length;

  const processConfig: any = {
    title: 'Onchain Census Demo ' + Date.now(),
    description: 'Voting process using ICensusValidator onchain census',
    census,
    maxVoters,
    ballot: {
      numFields: 2,
      maxValue: maxValue.toString(),
      minValue: '0',
      uniqueValues: false,
      costFromWeight: false,
      costExponent: 1,
      maxValueSum: maxValueSum.toString(),
      minValueSum: '0',
    },
    timing: {
      startDate: new Date(Date.now() + 60 * 1000),
      duration: 3600 * 8,
    },
    questions: [
      {
        title: 'What is your favorite color?',
        description: 'Choose your preferred color',
        choices: [
          { title: 'Red', value: 0 },
          { title: 'Blue', value: 1 },
          { title: 'Green', value: 2 },
          { title: 'Yellow', value: 3 },
        ],
      },
      {
        title: 'What is your preferred transportation?',
        description: 'Select your most used mode of transportation',
        choices: [
          { title: 'Car', value: 0 },
          { title: 'Bike', value: 1 },
          { title: 'Public Transport', value: 2 },
          { title: 'Walking', value: 3 },
        ],
      },
    ],
  };

  const stream = sdk.createProcessStream(processConfig);
  let processId = '';

  for await (const event of stream) {
    switch (event.status) {
      case TxStatus.Pending:
        info(chalk.yellow('📝 Transaction submitted to blockchain'));
        break;
      case TxStatus.Completed:
        processId = event.response.processId;
        success(`Process created: ${processId}`);
        break;
      case TxStatus.Failed:
        throw event.error;
      case TxStatus.Reverted:
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown reason'}`);
    }
  }

  return processId;
}

async function step6_waitForProcessAndSequencerWeights(
  sdk: DavinciSDK,
  processId: string,
  participants: OnchainParticipant[]
): Promise<void> {
  step(6, 'Wait for process readiness and sequencer census import');

  await new Promise(r => setTimeout(r, 10000));

  let processReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const process = await sdk.api.sequencer.getProcess(processId);
      if (process.isAcceptingVotes) {
        processReady = true;
        break;
      }
    } catch {
      // continue
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  if (!processReady) {
    throw new Error('Process was not ready in time');
  }
  success('Process is accepting votes');

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    let imported = 0;
    for (const p of participants) {
      try {
        const weight = await sdk.api.sequencer.getAddressWeight(processId, p.address);
        if (Number(weight) > 0) imported++;
      } catch {
        // keep polling
      }
    }
    info(`Sequencer imported voters: ${imported}/${participants.length}`);
    if (imported === participants.length) {
      success('Sequencer imported all onchain voters');
      return;
    }
    await new Promise(r => setTimeout(r, 10000));
  }

  throw new Error('Timed out waiting for sequencer to import onchain census members');
}

async function step7_submitVotes(
  processId: string,
  participants: OnchainParticipant[],
  useWeights: boolean
): Promise<string[]> {
  step(7, `Submit votes${useWeights ? ' (with onchain weights)' : ''}`);

  const voteIds: string[] = [];
  const errors: Array<{ address: string; error: any }> = [];

  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    const choice1 = Math.floor(Math.random() * 4);
    const choice2 = Math.floor(Math.random() * 4);
    const q1 = [0, 0, 0, 0];
    const q2 = [0, 0, 0, 0];
    const weight = useWeights ? p.weight : 1;
    q1[choice1] = weight;
    q2[choice2] = weight;

    try {
      const voterSDK = new DavinciSDK(createSDKInstance(p.privateKey, false));
      await voterSDK.init();
      const vote = await voterSDK.submitVote({
        processId,
        choices: [...q1, ...q2],
      });
      voteIds.push(vote.voteId);
      success(`[${i + 1}/${participants.length}] Vote submitted: ${vote.voteId}`);
    } catch (error) {
      errors.push({ address: p.address, error });
      console.error(chalk.red(`[${i + 1}/${participants.length}] Vote failed for ${p.address}`), error);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Failed votes: ${errors.length}/${participants.length}`);
  }

  return voteIds;
}

async function step8_waitVotesSettled(
  sdk: DavinciSDK,
  processId: string,
  voteIds: string[]
): Promise<void> {
  step(8, 'Wait for vote settlement');

  const settled = new Set<string>();
  await Promise.all(
    voteIds.map(async voteId => {
      const stream = sdk.watchVoteStatus(processId, voteId, {
        targetStatus: VoteStatus.Settled,
        timeoutMs: 800000,
        pollIntervalMs: 5000,
      });
      for await (const status of stream) {
        if (status.status === VoteStatus.Error) {
          throw new Error(`Vote ${voteId} reached error state`);
        }
        if (status.status === VoteStatus.Settled) {
          settled.add(voteId);
          info(`Settled ${settled.size}/${voteIds.length}`);
        }
      }
    })
  );
}

async function run() {
  console.log(chalk.bold.cyan('\n🚀 Starting Onchain Census Demo\n'));

  try {
    const provider = new JsonRpcProvider(RPC_URL);
    const useWeights = parseBool(ONCHAIN_USE_WEIGHTS);
    const sdk = await step1_initializeSDK();
    const { contractAddress, startBlock, chainId } = await step2_resolveOnchainCensusContract(provider);
    const censusUri = await step3_startIndexerAndBuildUri(chainId, contractAddress, startBlock);
    const participants = await step4_loadParticipantsWithOnchainWeight(
      provider,
      contractAddress,
      useWeights
    );
    const processId = await step5_createProcess(sdk, censusUri, contractAddress, participants, useWeights);
    await step6_waitForProcessAndSequencerWeights(sdk, processId, participants);
    const voteIds = await step7_submitVotes(processId, participants, useWeights);
    await step8_waitVotesSettled(sdk, processId, voteIds);

    success('Onchain census voting flow completed');
    console.log(chalk.cyan(`Process ID: ${processId}`));
    console.log(chalk.cyan(`Census Contract: ${contractAddress}`));
    console.log(chalk.cyan(`Census URI: ${censusUri}`));
  } catch (error) {
    console.error(chalk.red('\n❌ Onchain demo failed:'), error);
    process.exit(1);
  }

  process.exit(0);
}

run().catch(error => {
  console.error(chalk.red('❌ Fatal error:'), error);
  process.exit(1);
});
