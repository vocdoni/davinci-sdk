#!/usr/bin/env ts-node

import { config } from "dotenv";
import { JsonRpcProvider, Wallet, isAddress } from "ethers";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
    VocdoniApiService,
    VoteBallot,
    DavinciCryptoOutput,
    CircomProof,
    Groth16Proof,
    ProofInputs as Groth16ProofInputs,
    DavinciCrypto,
    DavinciCryptoInputs,
    signProcessCreation,
    CensusOrigin
} from "../../../src";
import { getElectionMetadataTemplate, BallotMode as ApiBallotMode } from "../../../src/core";
import {
    SmartContractService,
    ProcessRegistryService,
    ProcessStatus,
    deployedAddresses as addresses
} from "../../../src/contracts";
import { Census, EncryptionKey } from "../../../src/core";
import { randomBytes } from "crypto";

config();

// ────────────────────────────────────────────────────────────
//   CONFIG / CONSTANTS
// ────────────────────────────────────────────────────────────
if (!process.env.SEQUENCER_API_URL) throw new Error("SEQUENCER_API_URL environment variable is required");
if (!process.env.CENSUS_API_URL) throw new Error("CENSUS_API_URL environment variable is required");
if (!process.env.SEPOLIA_RPC) throw new Error("SEPOLIA_RPC environment variable is required");
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY environment variable is required");

const SEQUENCER_API_URL          = process.env.SEQUENCER_API_URL;
const CENSUS_API_URL             = process.env.CENSUS_API_URL;
const RPC_URL                    = process.env.SEPOLIA_RPC;
const PRIVATE_KEY                = process.env.PRIVATE_KEY;
const FORCE_SEQUENCER_ADDRESSES  = process.env.FORCE_SEQUENCER_ADDRESSES === 'true';

// ────────────────────────────────────────────────────────────
//   LOGGING HELPERS
// ────────────────────────────────────────────────────────────
const info    = (msg: string) => console.log(chalk.cyan("ℹ"), msg);
const success = (msg: string) => console.log(chalk.green("✔"), msg);
const step    = (n: number, msg: string) =>
    console.log(chalk.yellow.bold(`\n[Step ${n}]`), chalk.white(msg));

// Log the configuration
if (FORCE_SEQUENCER_ADDRESSES) {
    info("FORCE_SEQUENCER_ADDRESSES is enabled - will use contract addresses from sequencer info endpoint");
} else {
    info("FORCE_SEQUENCER_ADDRESSES is disabled - will use environment variables or default addresses");
}

// Address variables will be set after fetching sequencer info
let PROCESS_REGISTRY_ADDR: string;
let ORGANIZATION_REGISTRY_ADDR: string;

// Ballot mode configuration for two questions with four options each (0-3)
const BALLOT_MODE: ApiBallotMode = {
    numFields:        2,  // Two questions
    maxValue:       "3", // Four options (0,1,2,3)
    minValue:       "0",
    uniqueValues: false,
    costFromWeight:  false,
    costExponent:    0,
    maxValueSum:   "6", // Sum of max values for both questions (3 + 3)
    minValueSum:    "0",
};

// ────────────────────────────────────────────────────────────
//   ADDRESS HELPERS
// ────────────────────────────────────────────────────────────
/**
 * Gets the process registry address from environment variables, sequencer info, or fallback to deployed addresses
 */
function getProcessRegistryAddress(sequencerContracts?: Record<string, string>): string {
    // Check if we should force using sequencer addresses
    if (FORCE_SEQUENCER_ADDRESSES && sequencerContracts?.process) {
        if (isAddress(sequencerContracts.process)) {
            info(`Using PROCESS_REGISTRY_ADDRESS from sequencer info: ${sequencerContracts.process}`);
            return sequencerContracts.process;
        } else {
            throw new Error(`Invalid process registry address from sequencer: ${sequencerContracts.process}`);
        }
    }
    
    // Check environment variable
    const envAddress = process.env.PROCESS_REGISTRY_ADDRESS;
    if (envAddress && isAddress(envAddress)) {
        info(`Using PROCESS_REGISTRY_ADDRESS from environment: ${envAddress}`);
        return envAddress;
    }
    
    // Fallback to default
    info(`Using default process registry address: ${addresses.processRegistry.sepolia}`);
    return addresses.processRegistry.sepolia;
}

/**
 * Gets the organization registry address from environment variables, sequencer info, or fallback to deployed addresses
 */
function getOrganizationRegistryAddress(sequencerContracts?: Record<string, string>): string {
    // Check if we should force using sequencer addresses
    if (FORCE_SEQUENCER_ADDRESSES && sequencerContracts?.organization) {
        if (isAddress(sequencerContracts.organization)) {
            info(`Using ORGANIZATION_REGISTRY_ADDRESS from sequencer info: ${sequencerContracts.organization}`);
            return sequencerContracts.organization;
        } else {
            throw new Error(`Invalid organization registry address from sequencer: ${sequencerContracts.organization}`);
        }
    }
    
    // Check environment variable
    const envAddress = process.env.ORGANIZATION_REGISTRY_ADDRESS;
    if (envAddress && isAddress(envAddress)) {
        info(`Using ORGANIZATION_REGISTRY_ADDRESS from environment: ${envAddress}`);
        return envAddress;
    }
    
    // Fallback to default
    info(`Using default organization registry address: ${addresses.organizationRegistry.sepolia}`);
    return addresses.organizationRegistry.sepolia;
}

// ────────────────────────────────────────────────────────────
//   BOOTSTRAP CLIENTS
// ────────────────────────────────────────────────────────────
function initClients() {
    const provider = new JsonRpcProvider(RPC_URL);
    const wallet   = new Wallet(PRIVATE_KEY, provider);
    const api      = new VocdoniApiService({
        sequencerURL: SEQUENCER_API_URL,
        censusURL: CENSUS_API_URL
    });
    return { api, provider, wallet };
}

// ────────────────────────────────────────────────────────────
//   PARTICIPANTS GENERATOR
// ────────────────────────────────────────────────────────────
type TestParticipant = { key: string; weight: string; secret: string };
function makeTestParticipants(): TestParticipant[] {
    const wallets = [
        ...Array.from({ length: 10 }, () => Wallet.createRandom())
    ];
    return wallets.map((w, i) => ({
        key:    w.address,
        weight: ((i + 1) * 10).toString(),
        secret: w.privateKey.replace(/^0x/, ""),
    }));
}


// ────────────────────────────────────────────────────────────
//   STEP 1: Ping the HTTP API
// ────────────────────────────────────────────────────────────
async function step1_ping(api: VocdoniApiService) {
    step(1, "Ping the HTTP API");
    await api.sequencer.ping();
    success("API reachable");
}

// ────────────────────────────────────────────────────────────
//   STEP 2: Fetch zk‐circuit & on‐chain info
// ────────────────────────────────────────────────────────────
interface InfoResp {
    circuitUrl: string;
    provingKeyUrl: string;
    verificationKeyUrl: string;
    ballotProofWasmHelperUrl: string;
    ballotProofWasmHelperExecJsUrl: string;
    contracts: Record<string, string>;
}
async function step2_fetchInfo(api: VocdoniApiService): Promise<InfoResp> {
    step(2, "Fetch zk‐circuit & on‐chain contract info");
    const info = await api.sequencer.getInfo();
    console.log("   circuitUrl:", info.circuitUrl);
    console.log("   contracts:", JSON.stringify(info.contracts, null, 2));
    return {
        circuitUrl: info.circuitUrl,
        provingKeyUrl: info.provingKeyUrl,
        verificationKeyUrl: info.verificationKeyUrl,
        ballotProofWasmHelperUrl: info.ballotProofWasmHelperUrl,
        ballotProofWasmHelperExecJsUrl: info.ballotProofWasmHelperExecJsUrl,
        contracts: info.contracts,
    };
}

// ────────────────────────────────────────────────────────────
//   STEP 3: Create Census
// ────────────────────────────────────────────────────────────
async function step3_createCensus(api: VocdoniApiService): Promise<string> {
    step(3, "Create a new census");
    const censusId = await api.census.createCensus();
    success(`censusId = ${censusId}`);
    return censusId;
}

// ────────────────────────────────────────────────────────────
//   STEP 4: Add Participants
// ────────────────────────────────────────────────────────────
async function step4_addParticipants(api: VocdoniApiService, censusId: string) {
    step(4, "Add participants to census");
    const participants = makeTestParticipants();
    await api.census.addParticipants(censusId, participants.map((p: TestParticipant) => ({
        key:    p.key,
        weight: p.weight
    })));
    success(`Added ${participants.length} participants`);
    return participants;
}

// ────────────────────────────────────────────────────────────
//   STEP 5: Publish Census
// ────────────────────────────────────────────────────────────
async function step5_publishCensus(api: VocdoniApiService, censusId: string) {
    step(5, "Publish census");
    
    const publishResult = await api.census.publishCensus(censusId);
    console.log("   census published with root:", publishResult.root);
    success("Census published successfully");
    
    return publishResult;
}

// ────────────────────────────────────────────────────────────
//   STEP 6: Fetch Census Size
// ────────────────────────────────────────────────────────────
async function step6_fetchCensusSize(api: VocdoniApiService, censusRoot: string) {
    step(6, "Fetch census size using census root");
    const size = await api.census.getCensusSize(censusRoot);
    console.log(`   root = ${censusRoot}`);
    console.log(`   size = ${size}`);
    success("Census ready");
    return { censusRoot, censusSize: size };
}

// ────────────────────────────────────────────────────────────
//   STEP 7: Push Election Metadata
// ────────────────────────────────────────────────────────────
async function step7_pushMetadata(api: VocdoniApiService): Promise<string> {
    step(7, "Push election metadata");
    const metadata = getElectionMetadataTemplate();
    metadata.title.default = "Test Election " + Date.now();
    metadata.description.default = "This is a test election created via script";
    
    // Set up two questions with three options each
    metadata.questions = [
        {
            title: {
                default: "What is your favorite color?",
            },
            description: {
                default: "Choose your preferred color from the options below",
            },
            meta: {},
            choices: [
                {
                    title: {
                        default: "Red",
                    },
                    value: 0,
                    meta: {},
                },
                {
                    title: {
                        default: "Blue",
                    },
                    value: 1,
                    meta: {},
                },
                {
                    title: {
                        default: "Green",
                    },
                    value: 2,
                    meta: {},
                },
                {
                    title: {
                        default: "Yellow",
                    },
                    value: 3,
                    meta: {},
                },
            ],
        },
        {
            title: {
                default: "What is your preferred transportation?",
            },
            description: {
                default: "Select your most used mode of transportation",
            },
            meta: {},
            choices: [
                {
                    title: {
                        default: "Car",
                    },
                    value: 0,
                    meta: {},
                },
                {
                    title: {
                        default: "Bike",
                    },
                    value: 1,
                    meta: {},
                },
                {
                    title: {
                        default: "Public Transport",
                    },
                    value: 2,
                    meta: {},
                },
                {
                    title: {
                        default: "Walking",
                    },
                    value: 3,
                    meta: {},
                },
            ],
        },
    ];
    
    const hash = await api.sequencer.pushMetadata(metadata);
    const metadataUrl = api.sequencer.getMetadataUrl(hash);
    console.log("   metadata hash:", hash);
    console.log("   metadata url:", metadataUrl);
    
    // Verify metadata was stored correctly
    const storedMetadata = await api.sequencer.getMetadata(hash);
    console.log("   metadata stored successfully:", storedMetadata.title.default);
    success("Metadata pushed to storage");
    return metadataUrl;
}

// ────────────────────────────────────────────────────────────
//   STEP 8: Create Process via Sequencer API
// ────────────────────────────────────────────────────────────
interface ApiFlowResult {
    censusId: string;
    participants: TestParticipant[];
    censusRoot: string;
    censusSize: number;
    processId: string;
    encryptionPubKey: [string, string];
    stateRoot: string;
    metadataUri: string;
}

async function step8_createProcess(
    api: VocdoniApiService,
    provider: JsonRpcProvider,
    wallet: Wallet,
    censusRoot: string,
    censusSize: number
): Promise<Pick<ApiFlowResult, "processId" | "encryptionPubKey" | "stateRoot">> {
    step(8, "Create process via Sequencer API");
    
    // Get the next process ID from the smart contract using wallet address as organizationId
    const registry = new ProcessRegistryService(PROCESS_REGISTRY_ADDR, wallet);
    const processId = await registry.getNextProcessId(wallet.address);
    
    console.log("   nextProcessId from contract:", processId);
    
    // Use the new signature format
    const signature = await signProcessCreation(processId, wallet);
    
    const { processId: returnedProcessId, encryptionPubKey, stateRoot } =
        await api.sequencer.createProcess({ processId, censusRoot, ballotMode: BALLOT_MODE, signature, censusOrigin: CensusOrigin.CensusOriginMerkleTree });
    
    console.log("   processId:", returnedProcessId);
    console.log("   pubKey:", encryptionPubKey);
    console.log("   stateRoot:", stateRoot);
    success("Process created via sequencer");
    return { processId: returnedProcessId, encryptionPubKey, stateRoot };
}

// ────────────────────────────────────────────────────────────
//   STEP 9: Submit newProcess on‐chain (simplified without organization)
// ────────────────────────────────────────────────────────────
async function step9_newProcessOnChain(
    wallet: Wallet,
    args: ApiFlowResult
) {
    step(9, "Submit newProcess on‐chain");
    const registry = new ProcessRegistryService(PROCESS_REGISTRY_ADDR, wallet);
    await SmartContractService.executeTx(
        registry.newProcess(
            ProcessStatus.READY,
            Math.floor(Date.now() / 1000) + 60,
            3600 * 8,
            BALLOT_MODE,
            {
                censusOrigin: 1,
                maxVotes: args.censusSize.toString(),
                censusRoot: args.censusRoot,
                censusURI: CENSUS_API_URL + `/censuses/${args.censusRoot}`
            } as Census,
            args.metadataUri,
            { x: args.encryptionPubKey[0], y: args.encryptionPubKey[1] } as EncryptionKey,
            BigInt(args.stateRoot)
        )
    );
    success("On‐chain newProcess mined");
}

// ────────────────────────────────────────────────────────────
//   STEP 10: Fetch on‐chain Process
// ────────────────────────────────────────────────────────────
async function step10_fetchOnChain(wallet: Wallet, processId: string) {
    step(10, "Fetch on‐chain process");
    const registry = new ProcessRegistryService(PROCESS_REGISTRY_ADDR, wallet);
    const stored = await registry.getProcess(processId);
    console.log(
        "   on‐chain getProcess:\n",
        JSON.stringify(stored, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v, 2
        )
    );
}

// ────────────────────────────────────────────────────────────
//   STEP 11: Generate zk‐SNARK inputs (Go/WASM) for each voter
// ────────────────────────────────────────────────────────────
async function step11_generateProofInputs(
    wasmExecUrl: string,
    wasmUrl: string,
    participants: TestParticipant[],
    processId: string,
    encryptionPubKey: [string, string],
    ballotMode: ApiBallotMode
): Promise<Array<{
    key: string;
    voteID: string;
    out: DavinciCryptoOutput;
    circomInputs: Groth16ProofInputs;
}>> {
    step(11, "Generate zk‐SNARK inputs for each participant");
    const sdk = new DavinciCrypto({ wasmExecUrl, wasmUrl });
    await sdk.init();

    const list: Array<{
        key: string;
        voteID: string;
        out: DavinciCryptoOutput;
        circomInputs: Groth16ProofInputs;
    }> = [];

    for (const p of participants) {
        const kHex = randomBytes(8).toString("hex");
        const kStr = BigInt("0x" + kHex).toString();

        // Generate random choices for each question (0-3)
        const randomChoice1 = Math.floor(Math.random() * 4);
        const randomChoice2 = Math.floor(Math.random() * 4);

        // Create arrays of 4 positions each (1 for selected choice, 0 for others)
        const question1Choices = Array(4).fill("0");
        const question2Choices = Array(4).fill("0");
        question1Choices[randomChoice1] = "1";
        question2Choices[randomChoice2] = "1";

        // Log the participant's choices
        const colorChoice = ["Red", "Blue", "Green", "Yellow"][randomChoice1];
        const transportChoice = ["Car", "Bike", "Public Transport", "Walking"][randomChoice2];
        console.log(`   • ${p.key} votes:
     Q1: ${colorChoice} (choice array: [${question1Choices.join(", ")}])
     Q2: ${transportChoice} (choice array: [${question2Choices.join(", ")}])`);

        const inputs: DavinciCryptoInputs = {
            address:       p.key.replace(/^0x/, ""),
            processID:     processId.replace(/^0x/, ""),
            encryptionKey: encryptionPubKey,
            k:             kStr,
            ballotMode,
            weight:        p.weight,
            fieldValues:   [...question1Choices, ...question2Choices], // Array of 8 positions
        };

        const out = await sdk.proofInputs(inputs);
        console.log(`   • ${p.key} → voteId=${out.voteId}`);
        list.push({
            key:          p.key,
            voteID:       out.voteId,
            out,
            circomInputs: out.circomInputs as Groth16ProofInputs
        });
    }

    success("All zk‐SNARK inputs generated");
    return list;
}

// ────────────────────────────────────────────────────────────
//   STEP 12: Run fullProve + verify for each input
// ────────────────────────────────────────────────────────────
async function step12_runGroth16Proofs(
    circuitUrl: string,
    provingKeyUrl: string,
    verificationKeyUrl: string,
    list: Array<{ key: string; voteID: string; circomInputs: Groth16ProofInputs }>
): Promise<Array<{ key: string; voteID: string; proof: Groth16Proof; publicSignals: string[] }>> {
    step(12, "Run snarkjs.fullProve + verify for each input");
    const pg = new CircomProof({
        wasmUrl: circuitUrl,
        zkeyUrl: provingKeyUrl,
        vkeyUrl: verificationKeyUrl
    });

    const results: Array<{ key: string; voteID: string; proof: Groth16Proof; publicSignals: string[] }> = [];
    for (const { key, voteID, circomInputs } of list) {
        info(` - generating proof for ${key}`);
        const { proof, publicSignals } = await pg.generate(circomInputs);
        info(` - verifying proof for ${key}`);
        const ok = await pg.verify(proof, publicSignals);
        if (!ok) throw new Error(`Proof verification failed for ${key}`);
        success(`✓ proof OK for ${key}`);
        results.push({ key, voteID, proof, publicSignals });
    }
    success("All proofs generated & verified");
    return results;
}

// ────────────────────────────────────────────────────────────
//   STEP 13: Wait for process to be ready
// ────────────────────────────────────────────────────────────
async function step13_waitForProcess(
    api: VocdoniApiService,
    processId: string
) {
    step(13, "Wait for process to be ready");
    
    while (true) {
        const process = await api.sequencer.getProcess(processId);
        if (process.isAcceptingVotes) {
            success("Process is ready to accept votes");
            break;
        }

        info("Process not ready yet, checking again in 10 seconds...");
        await new Promise(r => setTimeout(r, 10000));
    }
}

// ────────────────────────────────────────────────────────────
//   STEP 14: Submit one vote per participant
// ────────────────────────────────────────────────────────────
export async function step14_submitVotes(
    api: VocdoniApiService,
    wallet: Wallet,
    processId: string,
    censusRoot: string,
    participants: TestParticipant[],
    listProofInputs: Array<{ key: string; voteID: string; out: DavinciCryptoOutput; circomInputs: Groth16ProofInputs }>,
    proofs: Array<{ proof: Groth16Proof; publicSignals: string[] }>
): Promise<string[]> {
    step(14, "Submit votes for each participant");
    const voteIds: string[] = [];

    for (let i = 0; i < participants.length; i++) {
        const p = participants[i];
        const { out, voteID } = listProofInputs[i];
        const { proof }       = proofs[i];

        // 1) Merkle proof
        const censusProof = await api.census.getCensusProof(censusRoot, p.key);

        // 2) Map ciphertexts → VoteBallot shape
        const voteBallot: VoteBallot = {
            curveType: out.ballot.curveType,
            ciphertexts: out.ballot.ciphertexts,
        };

        // 3) Sign the raw bytes of the voteID
        const sigBytes = Uint8Array.from(Buffer.from(voteID.replace(/^0x/, ""), "hex"));
        const participantWallet = new Wallet("0x" + p.secret);
        const signature = await participantWallet.signMessage(sigBytes);

        // 4) Build and submit
        const voteRequest = {
            processId,
            censusProof,
            ballot:          voteBallot,
            ballotProof:     { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol },
            ballotInputsHash: out.ballotInputsHash,
            address:         participantWallet.address,
            signature,
            voteId:          voteID,
        };

        await api.sequencer.submitVote(voteRequest);
        success(`  [${i + 1}/${participants.length}] vote submitted successfully`);
        voteIds.push(voteID);

        // throttle
        await new Promise((r) => setTimeout(r, 200));
    }

    return voteIds;
}

async function step15_checkVotes(
    api: VocdoniApiService,
    processId: string,
    voteIds: string[]
) {
    step(15, "Check vote status for all submitted votes");

    for (let i = 0; i < voteIds.length; i++) {
        const voteId = voteIds[i];
        try {
            const status = await api.sequencer.getVoteStatus(processId, voteId);
            success(`  [${i + 1}/${voteIds.length}] Vote ${voteId} status: ${status.status}`);
        } catch (error) {
            throw new Error(`Failed to get status for vote ${voteId}: ${error}`);
        }
    }
    
    success("All vote statuses retrieved successfully");
}

// ────────────────────────────────────────────────────────────
//   STEP 16: Wait for votes to be processed
// ────────────────────────────────────────────────────────────
async function step16_waitForVotesProcessed(
    api: VocdoniApiService,
    processId: string,
    voteIds: string[]
) {
    step(16, "Wait for votes to be settled");
    
    while (true) {
        let allSettled = true;
        let settledCount = 0;

        for (let i = 0; i < voteIds.length; i++) {
            const status = await api.sequencer.getVoteStatus(processId, voteIds[i]);
            if (status.status === "settled") {
                settledCount++;
            } else {
                allSettled = false;
            }
        }

        if (allSettled) {
            success("All votes have been settled");
            break;
        }

        info(`${settledCount}/${voteIds.length} votes settled, checking again in 10 seconds...`);
        await new Promise(r => setTimeout(r, 10000));
    }
}

// ────────────────────────────────────────────────────────────
//   STEP 17: Verify votes
// ────────────────────────────────────────────────────────────
async function step17_verifyVotes(
    api: VocdoniApiService,
    processId: string,
    participants: TestParticipant[],
    listProofInputs: Array<{ out: DavinciCryptoOutput }>
) {
    step(17, "Verify votes");
    
    // Check that participants have voted
    for (let i = 0; i < participants.length; i++) {
        const hasVoted = await api.sequencer.hasAddressVoted(processId, participants[i].key);
        if (!hasVoted) {
            throw new Error(`Expected participant ${participants[i].key} to have voted`);
        }
        success(`  [${i + 1}/${participants.length}] Verified participant ${participants[i].key} has voted`);
    }

    // Note: Nullifier-based verification removed in new version
    success("Vote verification completed using hasAddressVoted");
}

// ────────────────────────────────────────────────────────────
//   STEP 18: End Process
// ────────────────────────────────────────────────────────────
async function step18_endProcess(wallet: Wallet, processId: string, expectedVoteCount: number) {
    step(18, "End the voting process");
    
    const registry = new ProcessRegistryService(PROCESS_REGISTRY_ADDR, wallet);
    
    // Wait for vote count to match expected votes
    info("Waiting for all votes to be counted on-chain...");
    while (true) {
        const process = await registry.getProcess(processId);
        const currentVotes = Number(process.voteCount);
        
        if (currentVotes === expectedVoteCount) {
            success(`Vote count matches expected (${currentVotes}/${expectedVoteCount})`);
            break;
        }

        info(`Current vote count: ${currentVotes}/${expectedVoteCount}, checking again in 10 seconds...`);
        await new Promise(r => setTimeout(r, 10000));
    }
    
    // End the process
    await SmartContractService.executeTx(
        registry.setProcessStatus(processId, ProcessStatus.ENDED)
    );
    success("Process ended successfully");
    
    // Wait for results to be set
    info("Waiting for process results to be set...");
    const resultsReady = new Promise<void>((resolve) => {
        registry.onProcessResultsSet((id: string, sender: string, result: bigint[]) => {
            if (id.toLowerCase() === processId.toLowerCase()) {
                console.log(`Results set by ${sender} with ${result.length} values`);
                resolve();
            }
        });
    });
    await resultsReady;
    success("Process results have been set");
}

// ────────────────────────────────────────────────────────────
//   STEP 19: Show Final Results
// ────────────────────────────────────────────────────────────
async function step19_showResults(wallet: Wallet, processId: string) {
    step(19, "Show final election results");
    
    const registry = new ProcessRegistryService(PROCESS_REGISTRY_ADDR, wallet);
    const process = await registry.getProcess(processId);
    
    console.log(chalk.cyan("\nElection Results:"));
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
    
    success("Results retrieved successfully");
}

// ────────────────────────────────────────────────────────────
//   ENTRY POINT
// ────────────────────────────────────────────────────────────
async function run() {
    console.log(chalk.bold.cyan("\n🚀 Starting end-to-end demo…\n"));

    const { api, provider, wallet } = initClients();

    await step1_ping(api);
    const info    = await step2_fetchInfo(api);
    
    // Set contract addresses based on environment variables and sequencer info
    PROCESS_REGISTRY_ADDR = getProcessRegistryAddress(info.contracts);
    ORGANIZATION_REGISTRY_ADDR = getOrganizationRegistryAddress(info.contracts);
    
    const censusId         = await step3_createCensus(api);
    const participants     = await step4_addParticipants(api, censusId);
    const publishResult    = await step5_publishCensus(api, censusId);
    const { censusRoot, censusSize } = await step6_fetchCensusSize(api, publishResult.root);

    const metadataUri = await step7_pushMetadata(api);
    const { processId, encryptionPubKey, stateRoot } =
        await step8_createProcess(api, provider, wallet, censusRoot, censusSize);

    // 9–10) on‐chain process registry (simplified without organization)
    await step9_newProcessOnChain(wallet, {
        censusId,
        participants,
        censusRoot,
        censusSize,
        processId,
        encryptionPubKey,
        stateRoot,
        metadataUri
    });
    await step10_fetchOnChain(wallet, processId);

    const listProofInputs = await step11_generateProofInputs(
        info.ballotProofWasmHelperExecJsUrl,
        info.ballotProofWasmHelperUrl,
        participants,
        processId,
        encryptionPubKey,
        BALLOT_MODE
    );

    const proofs = await step12_runGroth16Proofs(
        info.circuitUrl,
        info.provingKeyUrl,
        info.verificationKeyUrl,
        listProofInputs
    );

    // Wait for process to be ready
    await step13_waitForProcess(api, processId);

    const voteIds = await step14_submitVotes(
        api,
        wallet,
        processId,
        censusRoot,
        participants,
        listProofInputs,
        proofs
    );

    console.log(chalk.bold.cyan("\nVote IDs:"), voteIds);

    await step15_checkVotes(api, processId, voteIds);

    // Wait for votes to be processed
    await step16_waitForVotesProcessed(api, processId, voteIds);

    // Verify votes
    await step17_verifyVotes(api, processId, participants, listProofInputs);

    // End the process
    await step18_endProcess(wallet, processId, participants.length);

    // Show final results
    await step19_showResults(wallet, processId);

    console.log(chalk.bold.green("\n✅ All done!\n"));
    process.exit(0);
}

run().catch((err) => {
    console.error(chalk.red("❌ Fatal error:"), err);
    process.exit(1);
});
