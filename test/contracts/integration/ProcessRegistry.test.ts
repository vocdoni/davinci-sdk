// test/integration/ProcessRegistry.test.ts
import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });
import { JsonRpcProvider, Wallet, hexlify } from "ethers";
import {
    OrganizationRegistryService,
    ProcessRegistryService,
    ProcessStatus,
    SmartContractService, 
    deployedAddresses as addresses
} from "../../../src/contracts";
import { BallotMode, Census, EncryptionKey } from "../../../src/core";

jest.setTimeout(Number(process.env.TIME_OUT) || 120_000);

const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC!);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

const ORG_REGISTRY_ADDR  = addresses.organizationRegistry.sepolia;
const PROC_REGISTRY_ADDR = addresses.processRegistry.sepolia;

function randomHex(bytes: number): string {
    let hex = "";
    for (let i = 0; i < bytes * 2; i++) {
        hex += Math.floor(Math.random() * 16).toString(16);
    }
    return "0x" + hex;
}

describe("ProcessRegistryService Integration (Sepolia)", () => {
    let orgService: OrganizationRegistryService;
    let procService: ProcessRegistryService;

    let orgId: string;
    let processId: string;
    let initStateRoot: string;
    let initDuration: number;
    let initCensus: Census;
    const metadataURI = `ipfs://meta-${Date.now()}`;

    beforeAll(() => {
        orgService  = new OrganizationRegistryService(ORG_REGISTRY_ADDR, wallet);
        procService = new ProcessRegistryService(PROC_REGISTRY_ADDR, wallet);
    });

    afterAll(() => {
        orgService.removeAllListeners();
        procService.removeAllListeners();
    });

    it("should run full process lifecycle and emit events", async () => {
        //
        // 1) CREATE ORGANIZATION
        //
        orgId = Wallet.createRandom().address;
        const orgName = `Org-${Date.now()}`;
        const orgMeta = `ipfs://org-meta-${Date.now()}`;

        const orgCreated = new Promise<void>((resolve) => {
            orgService.onOrganizationCreated((id: string, creator: string) => {
                if (
                    id.toLowerCase() === orgId.toLowerCase() &&
                    creator.toLowerCase() === wallet.address.toLowerCase()
                ) resolve();
            });
        });

        await SmartContractService.executeTx(
            orgService.createOrganization(orgId, orgName, orgMeta, [wallet.address])
        );
        await orgCreated;

        // verify
        const { name: fetchedName, metadataURI: fetchedMeta } =
            await orgService.getOrganization(orgId);
        expect(fetchedName).toBe(orgName);
        expect(fetchedMeta).toBe(orgMeta);
        expect(await orgService.isAdministrator(orgId, wallet.address)).toBe(true);

        //
        // 2) PREPARE PROCESS PARAMETERS
        //
        processId      = randomHex(32);
        initStateRoot  = randomHex(32);
        initDuration   = 3600;  // seconds
        initCensus = {
            censusOrigin: 1,
            maxVotes:     "5",
            censusRoot:   randomHex(32),
            censusURI:    `ipfs://census-${Date.now()}`,
        };

        const ballotMode: BallotMode = {
            maxCount:        1,
            maxValue:       "10",
            minValue:       "0",
            forceUniqueness: false,
            costFromWeight:  false,
            costExponent:    0,
            maxTotalCost:   "10",
            minTotalCost:    "0",
        };

        const encryptionKey: EncryptionKey = {
            x: BigInt(randomHex(32)).toString(),
            y: BigInt(randomHex(32)).toString(),
        };

        //
        // 3) NEW PROCESS & WAIT ProcessCreated
        //
        const procCreated = new Promise<void>((resolve) => {
            procService.onProcessCreated((id: string, creator: string) => {
                if (
                    id.toLowerCase() === processId.toLowerCase() &&
                    creator.toLowerCase() === wallet.address.toLowerCase()
                ) resolve();
            });
        });

        await SmartContractService.executeTx(
            procService.newProcess(
                ProcessStatus.READY,
                Math.floor(Date.now()/1000) + 60,
                initDuration,
                ballotMode,
                initCensus,
                metadataURI,
                orgId,
                processId,
                encryptionKey,
                BigInt(initStateRoot)
            )
        );
        await procCreated;

        // initial on‐chain read
        const stored = await procService.getProcess(processId);
        expect(stored.organizationId.toLowerCase()).toBe(orgId.toLowerCase());
        expect(stored.status).toBe(BigInt(ProcessStatus.READY));
        expect(stored.duration).toBe(BigInt(initDuration));
        expect(stored.metadataURI).toBe(metadataURI);
        expect(stored.latestStateRoot).toBe(BigInt(initStateRoot));
        expect(stored.census.censusURI).toBe(initCensus.censusURI);
        expect(
            hexlify(stored.census.censusRoot).toLowerCase()
        ).toBe(
            hexlify(initCensus.censusRoot).toLowerCase()
        );

        //
        // 4) UPDATE CENSUS & WAIT CensusUpdated
        //
        const newCensus: Census = {
            ...initCensus,
            maxVotes: "10",
            censusURI: initCensus.censusURI + "-v2",
        };
        const censusUpdated = new Promise<void>((resolve) => {
            procService.onCensusUpdated((id: string, root: string, uri: string, maxVotes: bigint) => {
                if (
                    id.toLowerCase() === processId.toLowerCase() &&
                    hexlify(root).toLowerCase() === hexlify(newCensus.censusRoot).toLowerCase() &&
                    uri === newCensus.censusURI &&
                    maxVotes === BigInt(newCensus.maxVotes)
                ) resolve();
            });
        });
        await SmartContractService.executeTx(
            procService.setProcessCensus(processId, newCensus)
        );
        await censusUpdated;

        const afterC = await procService.getProcess(processId);
        expect(afterC.census.censusURI).toBe(newCensus.censusURI);
        expect(afterC.census.maxVotes).toBe(BigInt(newCensus.maxVotes));

        //
        // 5) UPDATE DURATION & WAIT ProcessDurationChanged
        //
        // compute a new end time 10 minutes from now
        const now = Math.floor(Date.now() / 1000);
        const newDuration = now + 10 * 60;

        const durationChanged = new Promise<void>((resolve) => {
            procService.onProcessDurationChanged((id: string, dur: bigint) => {
                if (
                    id.toLowerCase() === processId.toLowerCase() &&
                    dur === BigInt(newDuration)
                ) resolve();
            });
        });
        await SmartContractService.executeTx(
            procService.setProcessDuration(processId, newDuration)
        );
        await durationChanged;

        const afterD = await procService.getProcess(processId);
        expect(afterD.duration).toBe(BigInt(newDuration));

        //
        // 6) END PROCESS & WAIT ProcessStatusChanged
        //
        const ended = new Promise<void>((resolve) => {
            procService.onProcessStatusChanged((id: string, status: bigint) => {
                if (
                    id.toLowerCase() === processId.toLowerCase() &&
                    status === BigInt(ProcessStatus.ENDED)
                ) resolve();
            });
        });
        await SmartContractService.executeTx(
            procService.endProcess(processId)
        );
        await ended;

        const final = await procService.getProcess(processId);
        expect(final.status).toBe(BigInt(ProcessStatus.ENDED));
    });
});
