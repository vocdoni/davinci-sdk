#!/usr/bin/env ts-node

import { config } from "dotenv";
import { JsonRpcProvider, Wallet } from "ethers";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { Chain } from "@ethereumjs/common";
import {
    VocdoniApiService,
    VoteBallot,
    BallotProofOutput,
    CircomProof,
    Groth16Proof,
    ProofInputs as Groth16ProofInputs,
    BallotProof,
    BallotProofInputs
} from "../../../src/sequencer";
import { getElectionMetadataTemplate, BallotMode as ApiBallotMode } from "../../../src/core";
import {
    SmartContractService,
    ProcessRegistryService,
    OrganizationRegistryService,
    ProcessStatus,
    deployedAddresses as addresses
} from "../../../src/contracts";
import { Census, EncryptionKey } from "../../../src/core";
import { randomBytes } from "crypto";

config();

// ────────────────────────────────────────────────────────────
//   CONFIG / CONSTANTS
// ────────────────────────────────────────────────────────────
if (!process.env.API_URL) throw new Error("API_URL environment variable is required");
if (!process.env.SEPOLIA_RPC) throw new Error("SEPOLIA_RPC environment variable is required");
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY environment variable is required");

const API_URL                    = process.env.API_URL;
const RPC_URL                    = process.env.SEPOLIA_RPC;
const PRIVATE_KEY                = process.env.PRIVATE_KEY;

const PROCESS_REGISTRY_ADDR      = addresses.processRegistry.sepolia;
const ORGANIZATION_REGISTRY_ADDR = addresses.organizationRegistry.sepolia;

//const PROCESS_REGISTRY_ADDR      = "0xBC1A75100023add2E798f16790704372E2a36085";
//const ORGANIZATION_REGISTRY_ADDR = "0x4102a669FAAD42e6202b2c7bF5d6C5aB0F722217";

// Ballot mode configuration for two questions with four options each (0-3)
const BALLOT_MODE: ApiBallotMode = {
    maxCount:        2,  // Two questions
    maxValue:       "3", // Four options (0,1,2,3)
    minValue:       "0",
    forceUniqueness: false,
    costFromWeight:  false,
    costExponent:    0,
    maxTotalCost:   "6", // Sum of max values for both questions (3 + 3)
    minTotalCost:    "0",
};

// ────────────────────────────────────────────────────────────
//   LOGGING HELPERS
// ────────────────────────────────────────────────────────────
const info    = (msg: string) => console.log(chalk.cyan("ℹ"), msg);
const success = (msg: string) => console.log(chalk.green("✔"), msg);
const step    = (n: number, msg: string) =>
    console.log(chalk.yellow.bold(`\n[Step ${n}]`), chalk.white(msg));

// ────────────────────────────────────────────────────────────
//   BOOTSTRAP CLIENTS
// ────────────────────────────────────────────────────────────
function initClients() {
    const provider = new JsonRpcProvider(RPC_URL);
    const wallet   = new Wallet(PRIVATE_KEY, provider);
    const api      = new VocdoniApiService(API_URL);
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
//   STEP 0: Create Organization on‐chain
// ────────────────────────────────────────────────────────────
async function step0_createOrganization(wallet: Wallet): Promise<string> {
    step(0, "Create a new Organization on-chain");
    const orgService = new OrganizationRegistryService(
        ORGANIZATION_REGISTRY_ADDR,
        wallet
    );
    const orgId = Wallet.createRandom().address;
    const orgName = `Org-${Date.now()}`;
    const orgMeta = `ipfs://org-meta-${Date.now()}`;

    await SmartContractService.executeTx(
        orgService.createOrganization(orgId, orgName, orgMeta, [wallet.address])
    );
    success(`Organization created: ${orgId}`);
    return orgId;
}

// ────────────────────────────────────────────────────────────
//   STEP 1: Ping the HTTP API
// ────────────────────────────────────────────────────────────
async function step1_ping(api: VocdoniApiService) {
    step(1, "Ping the HTTP API");
    await api.ping();
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
    const info = await api.getInfo();
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
    const censusId = await api.createCensus();
    success(`censusId = ${censusId}`);
    return censusId;
}

// ────────────────────────────────────────────────────────────
//   STEP 4: Add Participants
// ────────────────────────────────────────────────────────────
async function step4_addParticipants(api: VocdoniApiService, censusId: string) {
    step(4, "Add participants to census");
    const participants = makeTestParticipants();
    await api.addParticipants(censusId, participants.map((p: TestParticipant) => ({
        key:    p.key,
        weight: p.weight
    })));
    success(`Added ${participants.length} participants`);
    return participants;
}

// ────────────────────────────────────────────────────────────
//   STEP 5: Verify Participants
// ────────────────────────────────────────────────────────────
async function step5_verifyParticipants(api: VocdoniApiService, censusId: string) {
    step(5, "Verify participants were stored");
    const got = await api.getParticipants(censusId);
    console.log("   got:", got.map((p) => `${p.key}(${p.weight})`).join(", "));
}

// ────────────────────────────────────────────────────────────
//   STEP 6: Fetch Census Root & Size
// ────────────────────────────────────────────────────────────
async function step6_fetchRootSize(api: VocdoniApiService, censusId: string) {
    step(6, "Fetch census root & size");
    const root = await api.getCensusRoot(censusId);
    const size = await api.getCensusSize(censusId);
    console.log(`   root = ${root}`);
    console.log(`   size = ${size}`);
    success("Census ready");
    return { censusRoot: root, censusSize: size };
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
    
    const hash = await api.pushMetadata(metadata);
    const metadataUrl = api.getMetadataUrl(hash);
    console.log("   metadata hash:", hash);
    console.log("   metadata url:", metadataUrl);
    
    // Verify metadata was stored correctly
    const storedMetadata = await api.getMetadata(hash);
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
    const chainId = Chain.Sepolia;
    const nonce   = await provider.getTransactionCount(wallet.address);
    const signature = await wallet.signMessage(`${chainId}${nonce}`);
    const { processId, encryptionPubKey, stateRoot } =
        await api.createProcess({ censusRoot, ballotMode: BALLOT_MODE, nonce, chainId, signature });
    console.log("   processId:", processId);
    console.log("   pubKey:", encryptionPubKey);
    console.log("   stateRoot:", stateRoot);
    success("Process created via sequencer");
    return { processId, encryptionPubKey, stateRoot };
}

// ────────────────────────────────────────────────────────────
//   STEP 9: Check Admin on‐chain
// ────────────────────────────────────────────────────────────
async function step9_checkAdmin(wallet: Wallet, orgId: string) {
    step(9, "Verify admin rights on OrganizationRegistry");
    const svc = new OrganizationRegistryService(
        ORGANIZATION_REGISTRY_ADDR,
        wallet
    );
    const isAdmin = await svc.isAdministrator(orgId, wallet.address);
    if (!isAdmin) throw new Error("Caller is not an organization admin");
    success("Admin rights confirmed");
}

// ────────────────────────────────────────────────────────────
//   STEP 10: Submit newProcess on‐chain
// ────────────────────────────────────────────────────────────
async function step10_newProcessOnChain(
    wallet: Wallet,
    orgId: string,
    args: ApiFlowResult
) {
    step(10, "Submit newProcess on‐chain");
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
                censusURI: args.censusId
            } as Census,
            args.metadataUri,
            orgId,
            args.processId,
            { x: args.encryptionPubKey[0], y: args.encryptionPubKey[1] } as EncryptionKey,
            BigInt(args.stateRoot)
        )
    );
    success("On‐chain newProcess mined");
}

// ────────────────────────────────────────────────────────────
//   STEP 11: Fetch on‐chain Process
// ────────────────────────────────────────────────────────────
async function step11_fetchOnChain(wallet: Wallet, processId: string) {
    step(11, "Fetch on‐chain process");
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
//   STEP 12: Generate zk‐SNARK inputs (Go/WASM) for each voter
// ────────────────────────────────────────────────────────────
async function step12_generateProofInputs(
    wasmExecUrl: string,
    wasmUrl: string,
    participants: TestParticipant[],
    processId: string,
    encryptionPubKey: [string, string],
    ballotMode: ApiBallotMode
): Promise<Array<{
    key: string;
    voteID: string;
    out: BallotProofOutput;
    circomInputs: Groth16ProofInputs;
}>> {
    step(12, "Generate zk‐SNARK inputs for each participant");
    const sdk = new BallotProof({ wasmExecUrl, wasmUrl });
    await sdk.init();

    const list: Array<{
        key: string;
        voteID: string;
        out: BallotProofOutput;
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

        const inputs: BallotProofInputs = {
            address:       p.key.replace(/^0x/, ""),
            processID:     processId.replace(/^0x/, ""),
            secret:        p.secret.substring(0, 12),
            encryptionKey: encryptionPubKey,
            k:             kStr,
            ballotMode,
            weight:        p.weight,
            fieldValues:   [...question1Choices, ...question2Choices], // Array of 8 positions
        };

        const out = await sdk.proofInputs(inputs);
        console.log(`   • ${p.key} → voteID=${out.voteID}`);
        list.push({
            key:          p.key,
            voteID:       out.voteID,
            out,
            circomInputs: out.circomInputs as Groth16ProofInputs
        });
    }

    success("All zk‐SNARK inputs generated");
    return list;
}

// ────────────────────────────────────────────────────────────
//   STEP 13: Run fullProve + verify for each input
// ────────────────────────────────────────────────────────────
async function step13_runGroth16Proofs(
    circuitUrl: string,
    provingKeyUrl: string,
    verificationKeyUrl: string,
    list: Array<{ key: string; voteID: string; circomInputs: Groth16ProofInputs }>
): Promise<Array<{ key: string; voteID: string; proof: Groth16Proof; publicSignals: string[] }>> {
    step(13, "Run snarkjs.fullProve + verify for each input");
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
//   STEP 14: Wait for process to be ready
// ────────────────────────────────────────────────────────────
async function step14_waitForProcess(
    api: VocdoniApiService,
    processId: string
) {
    step(14, "Wait for process to be ready");
    
    while (true) {
        const process = await api.getProcess(processId);
        if (process.isAcceptingVotes) {
            success("Process is ready to accept votes");
            break;
        }

        info("Process not ready yet, checking again in 10 seconds...");
        await new Promise(r => setTimeout(r, 10000));
    }
}

// ────────────────────────────────────────────────────────────
//   STEP 15: Submit one vote per participant
// ────────────────────────────────────────────────────────────
export async function step15_submitVotes(
    api: VocdoniApiService,
    wallet: Wallet,
    processId: string,
    censusRoot: string,
    participants: TestParticipant[],
    listProofInputs: Array<{ key: string; voteID: string; out: BallotProofOutput; circomInputs: Groth16ProofInputs }>,
    proofs: Array<{ proof: Groth16Proof; publicSignals: string[] }>
): Promise<string[]> {
    step(15, "Submit votes for each participant");
    const voteIds: string[] = [];

    for (let i = 0; i < participants.length; i++) {
        const p = participants[i];
        const { out, voteID } = listProofInputs[i];
        const { proof }       = proofs[i];

        // 1) Merkle proof
        const censusProof = await api.getCensusProof(censusRoot, p.key);

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
            commitment:      out.commitment,
            nullifier:       out.nullifier,
            censusProof,
            ballot:          voteBallot,
            ballotProof:     { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol },
            ballotInputsHash: out.ballotInputHash,
            address:         participantWallet.address,
            signature,
        };

        const voteId = await api.submitVote(voteRequest);
        success(`  [${i + 1}/${participants.length}] voteId = ${voteId}`);
        voteIds.push(voteId);

        // throttle
        await new Promise((r) => setTimeout(r, 200));
    }

    return voteIds;
}

async function step16_checkVoteIds<T>(
    a: T[],
    b: T[],
    label: string
) {
    step(16, "Check same voteIDs");

    console.log(chalk.yellow("\n→ expected voteIDs:"), a);
    console.log(chalk.yellow("→ returned voteIDs:"), b);

    if (a.length !== b.length) {
        throw new Error(`${label}: length mismatch (${a.length} vs ${b.length})`);
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            throw new Error(`${label}: element ${i} differs: ${a[i]} vs ${b[i]}`);
        }
    }
}

// ────────────────────────────────────────────────────────────
//   STEP 17: Wait for votes to be processed
// ────────────────────────────────────────────────────────────
async function step17_waitForVotesProcessed(
    api: VocdoniApiService,
    processId: string,
    voteIds: string[]
) {
    step(17, "Wait for votes to be settled");
    
    while (true) {
        let allSettled = true;
        let settledCount = 0;

        for (let i = 0; i < voteIds.length; i++) {
            const status = await api.getVoteStatus(processId, voteIds[i]);
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
//   STEP 18: Verify votes
// ────────────────────────────────────────────────────────────
async function step18_verifyVotes(
    api: VocdoniApiService,
    processId: string,
    participants: TestParticipant[],
    listProofInputs: Array<{ out: BallotProofOutput }>
) {
    step(18, "Verify votes");
    
    // Check that participants have voted
    for (let i = 0; i < participants.length; i++) {
        const hasVoted = await api.hasAddressVoted(processId, participants[i].key);
        if (!hasVoted) {
            throw new Error(`Expected participant ${participants[i].key} to have voted`);
        }
        success(`  [${i + 1}/${participants.length}] Verified participant ${participants[i].key} has voted`);
    }

    // Try to get votes by nullifier
    for (let i = 0; i < listProofInputs.length; i++) {
        const { out } = listProofInputs[i];
        try {
            const ballot = await api.getVoteByNullifier(processId, out.nullifier);
            success(`  [${i + 1}/${listProofInputs.length}] Retrieved vote for nullifier ${out.nullifier}`);
        } catch (error) {
            console.error(`Failed to get vote for nullifier ${out.nullifier}:`, error);
            throw error;
        }
    }
}

// ────────────────────────────────────────────────────────────
//   STEP 19: End Process
// ────────────────────────────────────────────────────────────
async function step19_endProcess(wallet: Wallet, processId: string, expectedVoteCount: number) {
    step(19, "End the voting process");
    
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
    
    // Wait for another script to move the process to RESULTS state
    info("Waiting for process to be in RESULTS state...");
    const resultsReady = new Promise<void>((resolve) => {
        registry.onProcessStatusChanged((id: string, status: bigint) => {
            if (
                id.toLowerCase() === processId.toLowerCase() &&
                status === BigInt(ProcessStatus.RESULTS)
            ) resolve();
        });
    });
    await resultsReady;
    success("Process is now in RESULTS state");
}

// ────────────────────────────────────────────────────────────
//   STEP 20: Show Final Results
// ────────────────────────────────────────────────────────────
async function step20_showResults(wallet: Wallet, processId: string) {
    step(20, "Show final election results");
    
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

    // 0) on‐chain organization
    const orgId = await step0_createOrganization(wallet);

    await step1_ping(api);
    const info    = await step2_fetchInfo(api);
    const censusId         = await step3_createCensus(api);
    const participants     = await step4_addParticipants(api, censusId);
    await step5_verifyParticipants(api, censusId);
    const { censusRoot, censusSize } = await step6_fetchRootSize(api, censusId);

    const metadataUri = await step7_pushMetadata(api);
    const { processId, encryptionPubKey, stateRoot } =
        await step8_createProcess(api, provider, wallet, censusRoot, censusSize);

    // 9–11) on‐chain process registry
    await step9_checkAdmin(wallet, orgId);
    await step10_newProcessOnChain(wallet, orgId, {
        censusId,
        participants,
        censusRoot,
        censusSize,
        processId,
        encryptionPubKey,
        stateRoot,
        metadataUri
    });
    await step11_fetchOnChain(wallet, processId);

    const listProofInputs = await step12_generateProofInputs(
        info.ballotProofWasmHelperExecJsUrl,
        info.ballotProofWasmHelperUrl,
        participants,
        processId,
        encryptionPubKey,
        BALLOT_MODE
    );

    const proofs = await step13_runGroth16Proofs(
        info.circuitUrl,
        info.provingKeyUrl,
        info.verificationKeyUrl,
        listProofInputs
    );

    // Wait for process to be ready
    await step14_waitForProcess(api, processId);

    const voteIds = await step15_submitVotes(
        api,
        wallet,
        processId,
        censusRoot,
        participants,
        listProofInputs,
        proofs
    );

    console.log(chalk.bold.cyan("\nVote IDs:"), voteIds);

    await step16_checkVoteIds(
        listProofInputs.map((x) => x.voteID),
        voteIds,
        "voteID mismatch!"
    );

    // Wait for votes to be processed
    await step17_waitForVotesProcessed(api, processId, voteIds);

    // Verify votes
    await step18_verifyVotes(api, processId, participants, listProofInputs);

    // End the process
    await step19_endProcess(wallet, processId, participants.length);

    // Show final results
    await step20_showResults(wallet, processId);

    console.log(chalk.bold.green("\n✅ All done!\n"));
    process.exit(0);
}

run().catch((err) => {
    console.error(chalk.red("❌ Fatal error:"), err);
    process.exit(1);
});
