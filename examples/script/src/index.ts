#!/usr/bin/env ts-node

import chalk from 'chalk';
import { JsonRpcProvider, Wallet } from 'ethers';
import {
  DavinciSDK,
  CensusOrigin,
  VoteStatus,
  TxStatus,
  OffchainCensus,
  CspCensus,
  Census,
  CensusProviders,
  CSPCensusProofProvider,
} from '../../../src';
import {
  getUserConfiguration,
  generateTestParticipants,
  info,
  success,
  step,
  SEQUENCER_API_URL,
  CENSUS_API_URL,
  RPC_URL,
  PRIVATE_KEY,
  CSP_PRIVATE_KEY,
  type TestParticipant,
} from './utils';

// ────────────────────────────────────────────────────────────
//   CSP CENSUS PROVIDER
// ────────────────────────────────────────────────────────────
/**
 * Create a CSP census proof provider that uses DavinciCrypto
 */
function createCSPCensusProvider(
  sdk: DavinciSDK,
  participants: TestParticipant[]
): CSPCensusProofProvider {
  return async ({ processId, address }) => {
    info(
      `🔐 CSP Provider: Generating proof for ${address} in process ${processId.substring(0, 10)}...`
    );

    // Get DavinciCrypto from the existing SDK instance
    const davinciCrypto = await sdk.getCrypto();

    // Find the participant's weight
    const participant = participants.find(p => p.address.toLowerCase() === address.toLowerCase());
    const weight = participant?.weight || '1';

    // Generate CSP proof using the dummy CSP
    const cspProofData = await davinciCrypto.cspSign(
      CensusOrigin.CSP,
      CSP_PRIVATE_KEY,
      processId.replace(/^0x/, ''),
      address.replace(/^0x/, ''),
      weight
    );

    success(
      `✅ CSP Provider: Generated proof with signature ${cspProofData.signature.substring(0, 10)}... (weight: ${weight})`
    );

    return {
      root: cspProofData.root,
      address: cspProofData.address,
      weight: weight,
      censusOrigin: CensusOrigin.CSP,
      processId: cspProofData.processId,
      publicKey: cspProofData.publicKey,
      signature: cspProofData.signature,
    };
  };
}

// ────────────────────────────────────────────────────────────
//   SDK FACTORY
// ────────────────────────────────────────────────────────────
function createSDKInstance(privateKey: string, withProvider: boolean = true) {
  const signer = withProvider
    ? new Wallet(privateKey, new JsonRpcProvider(RPC_URL))
    : new Wallet(privateKey);

  return {
    signer,
    sequencerUrl: SEQUENCER_API_URL,
    censusUrl: CENSUS_API_URL,
  };
}

// ────────────────────────────────────────────────────────────
//   MAIN SCRIPT STEPS
// ────────────────────────────────────────────────────────────

/**
 * Step 1: Initialize the DavinciSDK
 */
async function step1_initializeSDK(): Promise<DavinciSDK> {
  step(1, 'Initialize DavinciSDK');

  const sdk = new DavinciSDK(createSDKInstance(PRIVATE_KEY));
  await sdk.init();
  success('SDK initialized successfully');

  return sdk;
}

/**
 * Step 2: Create Census with participants using Census classes
 */
async function step2_createCensus(
  sdk: DavinciSDK,
  numParticipants: number,
  censusType: CensusOrigin
): Promise<{
  census: Census;
  participants: TestParticipant[];
}> {
  step(
    2,
    censusType === CensusOrigin.CSP ? 'Create CSP census' : 'Create weighted census'
  );

  // Generate test participants
  const participants = generateTestParticipants(numParticipants);
  info(`Generated ${participants.length} test participants`);

  if (censusType === CensusOrigin.CSP) {
    // Create CSP census object
    const davinciCrypto = await sdk.getCrypto();
    const censusRoot = await davinciCrypto.cspCensusRoot(
      CensusOrigin.CSP,
      CSP_PRIVATE_KEY
    );

    const cspUri = `https://csp-server.com`;
    const census = new CspCensus(censusRoot, cspUri);

    success(`✨ CSP census created with root: ${censusRoot}`);
    success(`   CSP URI: ${cspUri}`);
    success(`   Ready for ${numParticipants} participants`);

    return { census, participants };
  } else {
    // Create OffchainCensus object
    const census = new OffchainCensus();

    // Add participants
    census.add(
      participants.map(p => ({
        key: p.address,
        weight: p.weight,
      }))
    );

    success(`OffchainCensus created with ${participants.length} participants`);

    return { census, participants };
  }
}

/**
 * Step 3: Create voting process
 */
async function step3_createProcess(
  sdk: DavinciSDK,
  census: Census,
  useWeights: boolean,
  maxWeight: number,
  numParticipants: number
): Promise<string> {
  step(3, `Create voting process${useWeights ? ' (with weighted voting)' : ''}`);

  // Calculate ballot limits based on whether weights are used
  // maxValue = maxOption * maxWeight (if weighted), or just maxOption (if not weighted)
  // maxValueSum = sum of all maxValues for all questions
  const maxOption = 3; // Options are 0,1,2,3
  const maxValue = useWeights ? maxOption * maxWeight : maxOption;
  const maxValueSum = useWeights ? maxValue * 2 : maxOption * 2; // 2 questions

  const processConfig = {
    title: 'Simplified Test Election ' + Date.now(),
    description: 'A simplified test election created with DavinciSDK',
    census: census,
    ballot: {
      numFields: 2, // Two questions
      maxValue: maxValue.toString(),
      minValue: '0',
      uniqueValues: false,
      costFromWeight: false,
      costExponent: 1,
      maxValueSum: maxValueSum.toString(),
      minValueSum: '0',
    },
    timing: {
      startDate: new Date(Date.now() + 60 * 1000), // Start in 1 minute
      duration: 3600 * 8, // 8 hours duration
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

  // For CSP census, maxVoters is required
  // For OffchainCensus, maxVoters is optional (auto-calculated from published census)
  if (census instanceof CspCensus) {
    processConfig.maxVoters = numParticipants;
  }

  const stream = sdk.createProcessStream(processConfig);

  let processId = '';
  let transactionHash = '';

  // Monitor transaction status in real-time
  for await (const event of stream) {
    switch (event.status) {
      case TxStatus.Pending:
        info(chalk.yellow('📝 Transaction submitted to blockchain'));
        info(chalk.gray(`   Hash: ${event.hash}`));
        info(chalk.gray('   Waiting for confirmation...'));
        transactionHash = event.hash;
        break;

      case TxStatus.Completed:
        processId = event.response.processId;
        transactionHash = event.response.transactionHash;
        success(chalk.green('✅ Transaction confirmed!'));
        success(chalk.green(`   Process ID: ${processId}`));
        info(chalk.gray(`   Transaction: ${transactionHash}`));
        break;

      case TxStatus.Failed:
        console.error(chalk.red('❌ Transaction failed!'));
        console.error(chalk.red(`   Error: ${event.error.message}`));
        throw event.error;

      case TxStatus.Reverted:
        console.error(chalk.red('⚠️  Transaction reverted!'));
        console.error(chalk.red(`   Reason: ${event.reason || 'Unknown reason'}`));
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown reason'}`);
    }
  }

  return processId;
}

/**
 * Step 4: Wait for process to be ready
 */
async function step4_waitForProcessReady(sdk: DavinciSDK, processId: string): Promise<void> {
  step(4, 'Wait for process to be ready');

  // Wait a bit for the process to be indexed by the sequencer
  info('Waiting for process to be indexed by sequencer...');
  await new Promise(r => setTimeout(r, 10000)); // Wait 10 seconds initially

  let attempts = 0;
  const maxAttempts = 20; // Maximum 20 attempts (about 2 minutes)

  while (attempts < maxAttempts) {
    try {
      const process = await sdk.api.sequencer.getProcess(processId);
      if (process.isAcceptingVotes) {
        success('Process is ready to accept votes');
        return;
      }

      info(
        `Process found but not ready yet (status: ${process.status}), checking again in 10 seconds...`
      );
      await new Promise(r => setTimeout(r, 10000));
    } catch (error: any) {
      attempts++;
      if (error.code === 40007) {
        // Process not found
        info(`Process not indexed yet (attempt ${attempts}/${maxAttempts}), waiting 10 seconds...`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        throw error; // Re-throw other errors
      }
    }
  }

  throw new Error(
    `Process ${processId} was not ready after ${maxAttempts} attempts. Please check if the transaction was mined successfully.`
  );
}

/**
 * Step 5: Submit votes for all participants
 */
async function step5_submitVotes(
  sdk: DavinciSDK,
  processId: string,
  participants: TestParticipant[],
  censusType: CensusOrigin,
  useWeights: boolean
): Promise<string[]> {
  step(5, `Submit votes for all participants${useWeights ? ' (with weights)' : ''}`);

  const BATCH_SIZE = 5; // Number of votes to send concurrently in each batch
  const voteIds: string[] = [];
  const errors: Array<{ participant: TestParticipant; error: any; index: number }> = [];

  // Split participants into batches
  const batches: TestParticipant[][] = [];
  for (let i = 0; i < participants.length; i += BATCH_SIZE) {
    batches.push(participants.slice(i, i + BATCH_SIZE));
  }

  info(`Submitting votes in ${batches.length} batches of up to ${BATCH_SIZE} votes each`);

  // Process each batch
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchStartIndex = batchIndex * BATCH_SIZE;
    
    info(chalk.cyan(`\n📦 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} votes)`));

    // Submit all votes in the batch concurrently
    const batchPromises = batch.map(async (participant, indexInBatch) => {
      const globalIndex = batchStartIndex + indexInBatch;
      const weight = parseInt(participant.weight);

      // Generate random choices for each question (0-3)
      const choice1 = Math.floor(Math.random() * 4);
      const choice2 = Math.floor(Math.random() * 4);

      // Create arrays of 4 positions each
      const question1Choices = Array(4).fill(0);
      const question2Choices = Array(4).fill(0);

      // If using weights, multiply by participant weight
      if (useWeights) {
        question1Choices[choice1] = weight;
        question2Choices[choice2] = weight;
      } else {
        question1Choices[choice1] = 1;
        question2Choices[choice2] = 1;
      }

      const colorChoice = ['Red', 'Blue', 'Green', 'Yellow'][choice1];
      const transportChoice = ['Car', 'Bike', 'Public Transport', 'Walking'][choice2];

      info(
        `[${globalIndex + 1}/${participants.length}] ${participant.address} (weight: ${weight}) voting: ${colorChoice}, ${transportChoice}`
      );
      info(
        `   Choice arrays: Q1=[${question1Choices.join(', ')}], Q2=[${question2Choices.join(', ')}]`
      );

      try {
        const baseConfig = createSDKInstance(participant.privateKey, false);

        const voterConfig: any =
          censusType === CensusOrigin.CSP
            ? {
                ...baseConfig,
                censusProviders: {
                  csp: createCSPCensusProvider(sdk, participants),
                } as CensusProviders,
              }
            : baseConfig;

        const voterSDK = new DavinciSDK(voterConfig);
        await voterSDK.init();

        const voteResult = await voterSDK.submitVote({
          processId,
          choices: [...question1Choices, ...question2Choices], // Array of 8 positions
        });

        voteIds.push(voteResult.voteId);
        success(`[${globalIndex + 1}/${participants.length}] ✅ Vote submitted: ${voteResult.voteId}`);

        return { success: true, voteId: voteResult.voteId };
      } catch (error) {
        // Log the error but don't throw - we want to try all votes
        console.error(chalk.red(`[${globalIndex + 1}/${participants.length}] ❌ Failed to submit vote for ${participant.address}:`), error);
        errors.push({ participant, error, index: globalIndex });
        return { success: false, error };
      }
    });

    // Wait for all votes in this batch to complete
    await Promise.all(batchPromises);
    
    // Small delay between batches
    if (batchIndex < batches.length - 1) {
      info(chalk.gray(`   Waiting 2 seconds before next batch...`));
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Summary
  console.log(chalk.cyan('\n📊 Vote Submission Summary:'));
  info(`   Total participants: ${participants.length}`);
  success(`   Successfully submitted: ${voteIds.length}`);
  if (errors.length > 0) {
    console.error(chalk.red(`   Failed: ${errors.length}`));
  }

  // If there were any errors, throw them now after attempting all votes
  if (errors.length > 0) {
    console.error(chalk.red('\n❌ The following votes failed:'));
    errors.forEach(({ participant, error, index }) => {
      console.error(chalk.red(`   [${index + 1}] ${participant.address}: ${error.message || error}`));
    });
    throw new Error(
      `Failed to submit ${errors.length} out of ${participants.length} votes. See above for details.`
    );
  }

  success(`\n✅ All ${voteIds.length} votes submitted successfully`);
  return voteIds;
}

/**
 * Step 6: Wait for all votes to be processed using watchVoteStatus
 */
async function step6_waitForVotesProcessed(
  sdk: DavinciSDK,
  processId: string,
  voteIds: string[]
): Promise<void> {
  step(6, 'Wait for all votes to be processed (with real-time status monitoring)');

  info('Watching vote status changes in real-time...');
  info('Note: This may take several minutes depending on the sequencer processing time.');

  // Track settled votes
  const settledVotes = new Set<string>();
  const timeoutMs = 800000; // 13 minutes per vote

  // Watch each vote's status changes
  const watchPromises = voteIds.map(async (voteId, index) => {
    try {
      const stream = sdk.watchVoteStatus(processId, voteId, {
        targetStatus: VoteStatus.Settled,
        timeoutMs: timeoutMs,
        pollIntervalMs: 5000,
      });

      for await (const statusInfo of stream) {
        // Display status change with color coding
        const statusEmoji = {
          [VoteStatus.Pending]: '⏳',
          [VoteStatus.Verified]: '✓',
          [VoteStatus.Aggregated]: '📊',
          [VoteStatus.Processed]: '⚙️',
          [VoteStatus.Settled]: '✅',
          [VoteStatus.Error]: '❌',
        };

        const emoji = statusEmoji[statusInfo.status] || '•';
        // Show first 4 and last 6 chars of voteId for uniqueness
        const shortVoteId = `${voteId.substring(0, 4)}...${voteId.substring(voteId.length - 6)}`;
        // Pad index for alignment
        const indexStr = `[${(index + 1).toString().padStart(voteIds.length.toString().length, ' ')}/${voteIds.length}]`;
        info(`${indexStr} ${emoji} Vote ${shortVoteId} → ${statusInfo.status}`);

        // Check for error status
        if (statusInfo.status === VoteStatus.Error) {
          throw new Error(`Vote ${voteId} failed with error status`);
        }

        // Mark as settled when reached
        if (statusInfo.status === VoteStatus.Settled) {
          settledVotes.add(voteId);

          // Show progress
          info(`Progress: ${settledVotes.size}/${voteIds.length} votes settled`);
        }
      }
    } catch (error: any) {
      console.error(chalk.red(`Failed to watch vote ${voteId}:`), error.message);
      throw error;
    }
  });

  // Wait for all votes to be settled
  await Promise.all(watchPromises);

  success(`All ${voteIds.length} votes have been settled successfully!`);
}

/**
 * Step 7: End process and show results
 */
async function step7_endProcessAndShowResults(
  sdk: DavinciSDK,
  processId: string,
  expectedVoteCount: number
): Promise<void> {
  step(7, 'End process and show results');

  // Wait for all votes to be counted on-chain
  info('Waiting for all votes to be counted on-chain...');
  while (true) {
    const process = await sdk.getProcess(processId);
    const currentVotes = Number(process.votersCount);

    if (currentVotes === expectedVoteCount) {
      success(`Vote count matches expected (${currentVotes}/${expectedVoteCount})`);
      break;
    }

    info(
      `Current vote count: ${currentVotes}/${expectedVoteCount}, checking again in 10 seconds...`
    );
    await new Promise(r => setTimeout(r, 10000));
  }

  // End the process with real-time transaction monitoring
  info('Ending the voting process...');
  const stream = sdk.endProcessStream(processId);

  for await (const event of stream) {
    switch (event.status) {
      case TxStatus.Pending:
        info(chalk.yellow('📝 Transaction submitted to blockchain'));
        info(chalk.gray(`   Hash: ${event.hash}`));
        info(chalk.gray('   Waiting for confirmation...'));
        break;

      case TxStatus.Completed:
        success(chalk.green('✅ Transaction confirmed!'));
        info(chalk.gray('   Process has been ended'));
        break;

      case TxStatus.Failed:
        console.error(chalk.red('❌ Transaction failed!'));
        console.error(chalk.red(`   Error: ${event.error.message}`));
        throw event.error;

      case TxStatus.Reverted:
        console.error(chalk.red('⚠️  Transaction reverted!'));
        console.error(chalk.red(`   Reason: ${event.reason || 'Unknown reason'}`));
        throw new Error(`Transaction reverted: ${event.reason || 'Unknown reason'}`);
    }
  }

  success('Process ended successfully');

  // Wait for results to be set
  info('Waiting for process results to be set...');
  const resultsReady = new Promise<void>(resolve => {
    sdk.processes.onProcessResultsSet((id: string, sender: string, result: bigint[]) => {
      if (id.toLowerCase() === processId.toLowerCase()) {
        console.log(`Results set by ${sender}`);
        resolve();
      }
    });
  });
  await resultsReady;
  success('Process results have been set');

  // Show final results
  const process = await sdk.getProcess(processId);

  console.log(chalk.cyan('\n🗳️  Election Results:'));
  console.log(chalk.yellow('\nQuestion 1: What is your favorite color?'));
  console.log('Red (0):              ', process.result[0].toString());
  console.log('Blue (1):             ', process.result[1].toString());
  console.log('Green (2):            ', process.result[2].toString());
  console.log('Yellow (3):           ', process.result[3].toString());

  console.log(chalk.yellow('\nQuestion 2: What is your preferred transportation?'));
  console.log('Car (0):              ', process.result[4].toString());
  console.log('Bike (1):             ', process.result[5].toString());
  console.log('Public Transport (2): ', process.result[6].toString());
  console.log('Walking (3):          ', process.result[7].toString());

  success('Results displayed successfully');
}

// ────────────────────────────────────────────────────────────
//   MAIN ENTRY POINT
// ────────────────────────────────────────────────────────────
async function run() {
  console.log(chalk.bold.cyan('\n🚀 Starting DavinciSDK Demo\n'));

  try {
    // Get user configuration
    const userConfig = await getUserConfiguration();
    const censusTypeName =
      userConfig.censusType === CensusOrigin.CSP ? 'CSP' : 'MerkleTree';
    console.log(
      chalk.green(
        `\n✓ Configuration: ${userConfig.numParticipants} participants, ${censusTypeName} census\n`
      )
    );

    // Step 1: Initialize SDK
    const sdk = await step1_initializeSDK();

    // Step 2: Create census
    const { census, participants } = await step2_createCensus(
      sdk,
      userConfig.numParticipants,
      userConfig.censusType
    );

    // Calculate maximum weight from participants
    const maxWeight = Math.max(...participants.map(p => parseInt(p.weight)));

    // Step 3: Create process
    const processId = await step3_createProcess(sdk, census, userConfig.useWeights, maxWeight, participants.length);

    // Step 4: Wait for process to be ready
    await step4_waitForProcessReady(sdk, processId);

    // Step 5: Submit votes
    const voteIds = await step5_submitVotes(
      sdk,
      processId,
      participants,
      userConfig.censusType,
      userConfig.useWeights
    );

    // Step 6: Wait for votes to be processed
    await step6_waitForVotesProcessed(sdk, processId, voteIds);

    // Step 7: End process and show results
    await step7_endProcessAndShowResults(sdk, processId, participants.length);

    console.log(chalk.bold.green('\n✅ Demo completed successfully!\n'));
    console.log(chalk.cyan(`📊 Process ID: ${processId}`));
    console.log(chalk.cyan(`🗳️  Total votes: ${participants.length}`));
    console.log(chalk.cyan(`🎯 Vote IDs: ${voteIds.length} votes submitted`));
  } catch (error) {
    console.error(chalk.red('\n❌ Demo failed:'), error);
    process.exit(1);
  }

  process.exit(0);
}

// Run the demo
run().catch(error => {
  console.error(chalk.red('❌ Fatal error:'), error);
  process.exit(1);
});
