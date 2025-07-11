// src/ProcessRegistryService.ts
import {
    ProcessRegistry__factory,
    type ProcessRegistry,
    type IProcessRegistry
} from "@vocdoni/davinci-contracts";
import { SmartContractService } from "./SmartContractService";
import type { ContractRunner } from "ethers";
import { BallotMode, Census, EncryptionKey } from '../core';
import {
    ProcessCreateError,
    ProcessStatusError,
    ProcessCensusError,
    ProcessDurationError,
    ProcessStateTransitionError,
    ProcessResultError,
} from "./errors";
import type {
    ProcessCreatedCallback,
    ProcessStatusChangedCallback,
    ProcessCensusUpdatedCallback,
    ProcessDurationChangedCallback,
    ProcessStateRootUpdatedCallback,
    ProcessResultsSetCallback,
} from "./types";

export enum ProcessStatus {
    READY   = 0,
    ENDED   = 1,
    CANCELED= 2,
    PAUSED  = 3,
    RESULTS = 4,
}

export class ProcessRegistryService extends SmartContractService {
    private contract: ProcessRegistry;

    constructor(contractAddress: string, runner: ContractRunner) {
        super();
        this.contract = ProcessRegistry__factory.connect(contractAddress, runner);
    }

    // ─── READS ─────────────────────────────────────────────────────────

    async getProcess(processID: string) {
        return this.contract.getProcess(processID);
    }

    async getProcessCount(): Promise<number> {
        const c = await this.contract.processCount();
        return Number(c);
    }

    async getChainID(): Promise<string> {
        const chainId = await this.contract.chainID();
        return chainId.toString();
    }

    async getNextProcessId(organizationId: string): Promise<string> {
        return this.contract.getNextProcessId(organizationId);
    }

    async getProcessEndTime(processID: string): Promise<bigint> {
        return this.contract.getProcessEndTime(processID);
    }

    async getRVerifierVKeyHash(): Promise<string> {
        return this.contract.getRVerifierVKeyHash();
    }

    async getSTVerifierVKeyHash(): Promise<string> {
        return this.contract.getSTVerifierVKeyHash();
    }

    async getMaxCensusOrigin(): Promise<bigint> {
        return this.contract.MAX_CENSUS_ORIGIN();
    }

    async getMaxStatus(): Promise<bigint> {
        return this.contract.MAX_STATUS();
    }

    async getProcessNonce(address: string): Promise<bigint> {
        return this.contract.processNonce(address);
    }

    async getProcessDirect(processID: string) {
        return this.contract.processes(processID);
    }

    async getRVerifier(): Promise<string> {
        return this.contract.rVerifier();
    }

    async getSTVerifier(): Promise<string> {
        return this.contract.stVerifier();
    }

    // ─── WRITES ────────────────────────────────────────────────────────

    newProcess(
        status: ProcessStatus,
        startTime: number,
        duration: number,
        ballotMode: BallotMode,
        census: Census,
        metadata: string,
        encryptionKey: EncryptionKey,
        initStateRoot: bigint
    ) {
        // Convert Census type from core to contract format
        const contractCensus: IProcessRegistry.CensusStruct = {
            censusOrigin: BigInt(census.censusOrigin),
            maxVotes: BigInt(census.maxVotes),
            censusRoot: census.censusRoot,
            censusURI: census.censusURI
        };

        return this.sendTx(
            this.contract.newProcess(
                status,
                startTime,
                duration,
                ballotMode,
                contractCensus,
                metadata,
                encryptionKey,
                initStateRoot
            ).catch(e => { throw new ProcessCreateError(e.message, 'create') }),
            async () => ({ success: true })
        );
    }

    setProcessStatus(processID: string, newStatus: ProcessStatus) {
        return this.sendTx(
            this.contract.setProcessStatus(processID, newStatus).catch(e => {
                throw new ProcessStatusError(e.message, 'setStatus');
            }),
            async () => ({ success: true })
        );
    }

    setProcessCensus(processID: string, census: Census) {
        // Convert Census type from core to contract format
        const contractCensus: IProcessRegistry.CensusStruct = {
            censusOrigin: BigInt(census.censusOrigin),
            maxVotes: BigInt(census.maxVotes),
            censusRoot: census.censusRoot,
            censusURI: census.censusURI
        };

        return this.sendTx(
            this.contract.setProcessCensus(processID, contractCensus).catch(e => {
                throw new ProcessCensusError(e.message, 'setCensus');
            }),
            async () => ({ success: true })
        );
    }

    setProcessDuration(processID: string, duration: number) {
        return this.sendTx(
            this.contract.setProcessDuration(processID, duration).catch(e => {
                throw new ProcessDurationError(e.message, 'setDuration');
            }),
            async () => ({ success: true })
        );
    }

    /**
     * Matches the on-chain `submitStateTransition(processId, proof, input)`
     */
    submitStateTransition(
        processID: string,
        proof: string,
        input: string
    ) {
        return this.sendTx(
            this.contract
                .submitStateTransition(processID, proof, input)
                .catch(e => {
                    throw new ProcessStateTransitionError(e.message, 'submitStateTransition');
                }),
            async () => ({ success: true })
        );
    }

    /**
     * Sets the results for a voting process.
     * 
     * @param processID - The ID of the process to set results for
     * @param proof - Zero-knowledge proof validating the results
     * @param input - Input data for the proof verification
     * @returns A transaction stream that resolves to success status
     */
    setProcessResults(processID: string, proof: string, input: string) {
        return this.sendTx(
            this.contract.setProcessResults(
                processID,
                proof,
                input
            ).catch(e => {
                throw new ProcessResultError(e.message, 'setResults');
            }),
            async () => ({ success: true })
        );
    }

    // ─── EVENT LISTENERS ───────────────────────────────────────────────────────

    onProcessCreated(cb: ProcessCreatedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessCreated(),
            this.normalizeListener<[string, string]>(cb)
        );
    }

    onProcessStatusChanged(cb: ProcessStatusChangedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessStatusChanged(),
            this.normalizeListener<[string, bigint, bigint]>(cb)
        );
    }

    onCensusUpdated(cb: ProcessCensusUpdatedCallback): void {
        this.contract.on(
            this.contract.filters.CensusUpdated(),
            this.normalizeListener<[string, string, string, bigint]>(cb)
        );
    }

    onProcessDurationChanged(cb: ProcessDurationChangedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessDurationChanged(),
            this.normalizeListener<[string, bigint]>(cb)
        );
    }

    onStateRootUpdated(cb: ProcessStateRootUpdatedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessStateRootUpdated(),
            this.normalizeListener<[string, string, bigint]>(cb)
        );
    }

    onProcessResultsSet(cb: ProcessResultsSetCallback): void {
        this.contract.on(
            this.contract.filters.ProcessResultsSet(),
            this.normalizeListener<[string, string, bigint[]]>(cb)
        );
    }

    removeAllListeners(): void {
        this.contract.removeAllListeners();
    }
}
