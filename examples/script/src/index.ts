#!/usr/bin/env ts-node

import chalk from "chalk";
import { JsonRpcProvider, Wallet } from "ethers";
import { DavinciSDK, CensusOrigin, ProcessStatus, VoteStatus } from "../../../src";
import { 
    getUserConfiguration, 
    generateTestParticipants,
    info, 
    success, 
    step,
    SEQUENCER_API_URL,
    CENSUS_API_URL,
    RPC_URL,
    USE_SEQUENCER_ADDRESSES,
    PRIVATE_KEY,
    type TestParticipant
} from "./utils";

// ────────────────────────────────────────────────────────────
//   SDK FACTORY
// ────────────────────────────────────────────────────────────
function createSDKInstance(privateKey: string) {
    const provider = new JsonRpcProvider(RPC_URL);
    const signer = new Wallet(privateKey, provider);
    
    return {
        signer,
        environment: 'dev',
        sequencerUrl: SEQUENCER_API_URL,
        censusUrl: CENSUS_API_URL,
        chain: 'sepolia',
        useSequencerAddresses: USE_SEQUENCER_ADDRESSES
    };
}

// ────────────────────────────────────────────────────────────
//   MAIN SCRIPT STEPS
// ────────────────────────────────────────────────────────────

/**
 * Step 1: Initialize the DavinciSDK
 */
async function step1_initializeSDK(): Promise<DavinciSDK> {
    step(1, "Initialize DavinciSDK");
    
    const sdk = new DavinciSDK(createSDKInstance(PRIVATE_KEY));
    await sdk.init();
    success("SDK initialized successfully");
    
    return sdk;
}

/**
 * Step 2: Create Census with participants
 */
async function step2_createCensus(sdk: DavinciSDK, numParticipants: number): Promise<{
    censusRoot: string;
    censusSize: number;
    censusUri: string;
    participants: TestParticipant[];
}> {
    step(2, "Create census with participants");
    
    // Generate test participants
    const participants = generateTestParticipants(numParticipants);
    info(`Generated ${participants.length} test participants`);
    
    // Create census
    const censusId = await sdk.api.census.createCensus();
    success(`Census created with ID: ${censusId}`);
    
    // Add participants to census
    await sdk.api.census.addParticipants(censusId, participants.map(p => ({
        key: p.address,
        weight: p.weight
    })));
    success(`Added ${participants.length} participants to census`);
    
    // Publish census
    const publishResult = await sdk.api.census.publishCensus(censusId);
    success(`Census published with root: ${publishResult.root}`);
    success(`Census URI: ${publishResult.uri}`);
    
    // Get census size
    const censusSize = await sdk.api.census.getCensusSize(publishResult.root);
    success(`Census ready with ${censusSize} participants`);
    
    return {
        censusRoot: publishResult.root,
        censusSize,
        censusUri: publishResult.uri,
        participants
    };
}

/**
 * Step 3: Create voting process using SDK
 */
async function step3_createProcess(
    sdk: DavinciSDK, 
    censusRoot: string, 
    censusSize: number,
    censusUri: string
): Promise<string> {
    step(3, "Create voting process");
    
    const processResult = await sdk.createProcess({
        title: "Simplified Test Election " + Date.now(),
        description: "A simplified test election created with DavinciSDK",
        census: {
            type: CensusOrigin.CensusOriginMerkleTree,
            root: censusRoot,
            size: censusSize,
            uri: censusUri
        },
        ballot: {
            numFields: 2,        // Two questions
            maxValue: "3",       // Four options (0,1,2,3)
            minValue: "0",
            uniqueValues: false,
            costFromWeight: false,
            costExponent: 0,
            maxValueSum: "6",    // Sum of max values (3 + 3)
            minValueSum: "0"
        },
        timing: {
            startDate: new Date(Date.now() + 60 * 1000), // Start in 1 minute
            duration: 3600 * 8 // 8 hours duration
        },
        questions: [
            {
                title: "What is your favorite color?",
                description: "Choose your preferred color",
                choices: [
                    { title: "Red", value: 0 },
                    { title: "Blue", value: 1 },
                    { title: "Green", value: 2 },
                    { title: "Yellow", value: 3 }
                ]
            },
            {
                title: "What is your preferred transportation?",
                description: "Select your most used mode of transportation",
                choices: [
                    { title: "Car", value: 0 },
                    { title: "Bike", value: 1 },
                    { title: "Public Transport", value: 2 },
                    { title: "Walking", value: 3 }
                ]
            }
        ]
    });
    
    success(`Process created with ID: ${processResult.processId}`);
    info(`Transaction hash: ${processResult.transactionHash}`);
    
    return processResult.processId;
}

/**
 * Step 4: Wait for process to be ready
 */
async function step4_waitForProcessReady(sdk: DavinciSDK, processId: string): Promise<void> {
    step(4, "Wait for process to be ready");
    
    // Wait a bit for the process to be indexed by the sequencer
    info("Waiting for process to be indexed by sequencer...");
    await new Promise(r => setTimeout(r, 10000)); // Wait 10 seconds initially
    
    let attempts = 0;
    const maxAttempts = 20; // Maximum 20 attempts (about 2 minutes)
    
    while (attempts < maxAttempts) {
        try {
            const process = await sdk.api.sequencer.getProcess(processId);
            if (process.isAcceptingVotes) {
                success("Process is ready to accept votes");
                return;
            }
            
            info(`Process found but not ready yet (status: ${process.status}), checking again in 10 seconds...`);
            await new Promise(r => setTimeout(r, 10000));
            
        } catch (error: any) {
            attempts++;
            if (error.code === 40007) { // Process not found
                info(`Process not indexed yet (attempt ${attempts}/${maxAttempts}), waiting 10 seconds...`);
                await new Promise(r => setTimeout(r, 10000));
            } else {
                throw error; // Re-throw other errors
            }
        }
    }
    
    throw new Error(`Process ${processId} was not ready after ${maxAttempts} attempts. Please check if the transaction was mined successfully.`);
}

/**
 * Step 5: Submit votes for all participants
 */
async function step5_submitVotes(
    sdk: DavinciSDK, 
    processId: string, 
    participants: TestParticipant[]
): Promise<string[]> {
    step(5, "Submit votes for all participants");
    
    const voteIds: string[] = [];
    
    for (let i = 0; i < participants.length; i++) {
        const participant = participants[i];
        
        // Generate random choices for each question (0-3)
        const choice1 = Math.floor(Math.random() * 4);
        const choice2 = Math.floor(Math.random() * 4);
        
        // Create arrays of 4 positions each (1 for selected choice, 0 for others)
        const question1Choices = Array(4).fill(0);
        const question2Choices = Array(4).fill(0);
        question1Choices[choice1] = 1;
        question2Choices[choice2] = 1;
        
        const colorChoice = ["Red", "Blue", "Green", "Yellow"][choice1];
        const transportChoice = ["Car", "Bike", "Public Transport", "Walking"][choice2];
        
        info(`[${i + 1}/${participants.length}] ${participant.address} voting: ${colorChoice}, ${transportChoice}`);
        info(`   Choice arrays: Q1=[${question1Choices.join(", ")}], Q2=[${question2Choices.join(", ")}]`);
        
        try {
            // Create a temporary SDK instance for this participant
            const participantSDK = new DavinciSDK(createSDKInstance(participant.privateKey));
            await participantSDK.init();
            
            const voteResult = await participantSDK.submitVote({
                processId,
                choices: [...question1Choices, ...question2Choices] // Array of 8 positions
            });
            
            voteIds.push(voteResult.voteId);
            success(`[${i + 1}/${participants.length}] Vote submitted: ${voteResult.voteId}`);
            
            // Small delay between votes
            await new Promise(r => setTimeout(r, 1000));
            
        } catch (error) {
            console.error(chalk.red(`Failed to submit vote for ${participant.address}:`), error);
            throw error;
        }
    }
    
    success(`All ${voteIds.length} votes submitted successfully`);
    return voteIds;
}

/**
 * Step 6: Wait for all votes to be processed
 */
async function step6_waitForVotesProcessed(
    sdk: DavinciSDK, 
    processId: string, 
    voteIds: string[]
): Promise<void> {
    step(6, "Wait for all votes to be processed");
    
    info("Waiting for all votes to reach 'settled' status...");
    info("Note: This may take several minutes depending on the sequencer processing time.");
    
    // Track vote statuses
    const voteStatuses = new Map<string, string>();
    const timeoutMs = 600000; // 10 minutes
    const pollIntervalMs = 5000; // 5 seconds
    const startTime = Date.now();
    
    // Initialize vote statuses
    for (const voteId of voteIds) {
        voteStatuses.set(voteId, "unknown");
    }
    
    // Poll until all votes are settled or timeout
    while (Date.now() - startTime < timeoutMs) {
        let allSettled = true;
        let settledCount = 0;
        
        // Check each vote status
        for (let i = 0; i < voteIds.length; i++) {
            const voteId = voteIds[i];
            const previousStatus = voteStatuses.get(voteId);
            
            try {
                const statusInfo = await sdk.getVoteStatus(processId, voteId);
                const currentStatus = statusInfo.status;
                
                // Print status change
                if (currentStatus !== previousStatus) {
                    info(`[${i + 1}/${voteIds.length}] Vote ${voteId}: ${previousStatus} → ${currentStatus}`);
                    voteStatuses.set(voteId, currentStatus);
                }
                
                if (currentStatus === VoteStatus.Settled) {
                    settledCount++;
                } else {
                    allSettled = false;
                }
                
                // Check for error status
                if (currentStatus === VoteStatus.Error) {
                    throw new Error(`Vote ${voteId} failed with error status`);
                }
                
            } catch (error) {
                throw new Error(`Failed to get status for vote ${voteId}: ${error}`);
            }
        }
        
        // Check if all votes are settled
        if (allSettled) {
            success(`All ${voteIds.length} votes have been settled successfully!`);
            return;
        }
        
        // Show progress
        info(`Progress: ${settledCount}/${voteIds.length} votes settled`);
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    
    // Timeout reached - throw error
    const finalStatuses = Array.from(voteStatuses.entries())
        .map(([voteId, status]) => `${voteId}: ${status}`)
        .join(', ');
    
    throw new Error(`Timeout reached! Not all votes settled within ${timeoutMs / 1000} seconds. Final statuses: ${finalStatuses}`);
}

/**
 * Step 7: End process and show results
 */
async function step7_endProcessAndShowResults(
    sdk: DavinciSDK, 
    processId: string, 
    expectedVoteCount: number
): Promise<void> {
    step(7, "End process and show results");
    
    // Wait for all votes to be counted on-chain
    info("Waiting for all votes to be counted on-chain...");
    while (true) {
        const process = await sdk.getProcess(processId);
        const currentVotes = Number(process.voteCount);
        
        if (currentVotes === expectedVoteCount) {
            success(`Vote count matches expected (${currentVotes}/${expectedVoteCount})`);
            break;
        }
        
        info(`Current vote count: ${currentVotes}/${expectedVoteCount}, checking again in 10 seconds...`);
        await new Promise(r => setTimeout(r, 10000));
    }
    
    // End the process
    info("Ending the voting process...");
    await sdk.processes.setProcessStatus(processId, ProcessStatus.ENDED);
    success("Process ended successfully");
    
    // Wait for results to be set
    info("Waiting for process results to be set...");
    const resultsReady = new Promise<void>((resolve) => {
        sdk.processes.onProcessResultsSet((id: string, sender: string, result: bigint[]) => {
            if (id.toLowerCase() === processId.toLowerCase()) {
                console.log(`Results set by ${sender}`);
                resolve();
            }
        });
    });
    await resultsReady;
    success("Process results have been set");
    
    // Show final results
    const process = await sdk.processes.getProcess(processId);
    
    console.log(chalk.cyan("\n🗳️  Election Results:"));
    console.log(chalk.yellow("\nQuestion 1: What is your favorite color?"));
    console.log("Red (0):              ", process.result[0].toString());
    console.log("Blue (1):             ", process.result[1].toString());
    console.log("Green (2):            ", process.result[2].toString());
    console.log("Yellow (3):           ", process.result[3].toString());
    
    console.log(chalk.yellow("\nQuestion 2: What is your preferred transportation?"));
    console.log("Car (0):              ", process.result[4].toString());
    console.log("Bike (1):             ", process.result[5].toString());
    console.log("Public Transport (2): ", process.result[6].toString());
    console.log("Walking (3):          ", process.result[7].toString());
    
    success("Results displayed successfully");
}

// ────────────────────────────────────────────────────────────
//   MAIN ENTRY POINT
// ────────────────────────────────────────────────────────────
async function run() {
    console.log(chalk.bold.cyan("\n🚀 Starting DavinciSDK Demo\n"));
    
    try {
        // Get user configuration
        const userConfig = await getUserConfiguration();
        console.log(chalk.green(`\n✓ Configuration: ${userConfig.numParticipants} participants, MerkleTree census\n`));
        
        // Step 1: Initialize SDK
        const sdk = await step1_initializeSDK();
        
        // Step 2: Create census
        const { censusRoot, censusSize, censusUri, participants } = await step2_createCensus(sdk, userConfig.numParticipants);
        
        // Step 3: Create process
        const processId = await step3_createProcess(sdk, censusRoot, censusSize, censusUri);
        
        // Step 4: Wait for process to be ready
        await step4_waitForProcessReady(sdk, processId);
        
        // Step 5: Submit votes
        const voteIds = await step5_submitVotes(sdk, processId, participants);
        
        // Step 6: Wait for votes to be processed
        await step6_waitForVotesProcessed(sdk, processId, voteIds);
        
        // Step 7: End process and show results
        await step7_endProcessAndShowResults(sdk, processId, participants.length);
        
        console.log(chalk.bold.green("\n✅ Demo completed successfully!\n"));
        console.log(chalk.cyan(`📊 Process ID: ${processId}`));
        console.log(chalk.cyan(`🗳️  Total votes: ${participants.length}`));
        console.log(chalk.cyan(`🎯 Vote IDs: ${voteIds.length} votes submitted`));
        
    } catch (error) {
        console.error(chalk.red("\n❌ Demo failed:"), error);
        process.exit(1);
    }
    
    process.exit(0);
}

// Run the demo
run().catch((error) => {
    console.error(chalk.red("❌ Fatal error:"), error);
    process.exit(1);
});
