// src/ProcessRegistryService.ts
import {
    ProcessRegistry__factory,
    type ProcessRegistry,
    type IProcessRegistry
} from "@vocdoni/davinci-contracts";
import { SmartContractService } from "./SmartContractService";
import type { ContractRunner } from "ethers";

// Custom errors
export class CreateProcessError      extends Error {}
export class SetStatusError          extends Error {}
export class SetCensusError          extends Error {}
export class SetDurationError        extends Error {}
export class SubmitStateTransitionError extends Error {}
export class SetResultError          extends Error {}

// Event callback types
type ProcessCreatedCallback      = (processID: string, creator: string) => void;
type StatusChangedCallback       = (processID: string, newStatus: bigint) => void;
type CensusUpdatedCallback      = (processID: string, root: string, uri: string, maxVotes: bigint) => void;
type DurationChangedCallback     = (processID: string, duration: bigint) => void;
type StateRootUpdatedCallback    = (processID: string, newStateRoot: bigint) => void;

// Typed helpers from the contract
export type BallotMode       = IProcessRegistry.BallotModeStruct;
export type Census           = IProcessRegistry.CensusStruct;
export type EncryptionKey    = IProcessRegistry.EncryptionKeyStruct;

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
        return this.contract.chainID();
    }

    // ─── WRITES ────────────────────────────────────────────────────────

    newProcess(
        status: ProcessStatus,
        startTime: number,
        duration: number,
        ballotMode: BallotMode,
        census: Census,
        metadata: string,
        organizationId: string,
        processID: string,
        encryptionKey: EncryptionKey,
        initStateRoot: bigint
    ) {
        return this.sendTx(
            this.contract.newProcess(
                status,
                startTime,
                duration,
                ballotMode,
                census,
                metadata,
                organizationId,
                processID,
                encryptionKey,
                initStateRoot
            ).catch(e => { throw new CreateProcessError(e.message) }),
            async () => ({ success: true })
        );
    }

    setProcessStatus(processID: string, newStatus: ProcessStatus) {
        return this.sendTx(
            this.contract.setProcessStatus(processID, newStatus).catch(e => {
                throw new SetStatusError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    /** convenience wrapper for "end" */
    endProcess(processID: string) {
        return this.setProcessStatus(processID, ProcessStatus.ENDED);
    }

    setProcessCensus(processID: string, census: Census) {
        return this.sendTx(
            this.contract.setProcessCensus(processID, census).catch(e => {
                throw new SetCensusError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    setProcessDuration(processID: string, duration: number) {
        return this.sendTx(
            this.contract.setProcessDuration(processID, duration).catch(e => {
                throw new SetDurationError(e.message);
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
                    throw new SubmitStateTransitionError(e.message);
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
                throw new SetResultError(e.message);
            }),
            async () => ({ success: true })
        );
    }

    onProcessCreated(cb: ProcessCreatedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessCreated(),
            this.normalizeListener<[string, string]>(cb)
        );
    }

    onProcessStatusChanged(cb: StatusChangedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessStatusChanged(),
            this.normalizeListener<[string, bigint]>(cb)
        );
    }

    onCensusUpdated(cb: CensusUpdatedCallback): void {
        this.contract.on(
            this.contract.filters.CensusUpdated(),
            this.normalizeListener<[string, string, string, bigint]>(cb)
        );
    }

    onProcessDurationChanged(cb: DurationChangedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessDurationChanged(),
            this.normalizeListener<[string, bigint]>(cb)
        );
    }

    onStateRootUpdated(cb: StateRootUpdatedCallback): void {
        this.contract.on(
            this.contract.filters.ProcessStateRootUpdated(),
            this.normalizeListener<[string, bigint]>(cb)
        );
    }

    removeAllListeners(): void {
        this.contract.removeAllListeners();
    }
}
