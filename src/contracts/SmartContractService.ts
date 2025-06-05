import type { ContractTransactionResponse } from "ethers";
import addressesJson from "@vocdoni/davinci-contracts/deployed_contracts_addresses.json";

/**
 * Interface defining the structure of deployed contract addresses across different networks.
 * Each contract has addresses for both Sepolia testnet and Ethereum mainnet.
 */
export interface DeployedAddresses {
    /** Process Registry contract addresses */
    processRegistry: {
        /** Sepolia testnet address */
        sepolia: string;
        /** Ethereum mainnet address */
        mainnet: string;
    };
    /** Organization Registry contract addresses */
    organizationRegistry: {
        /** Sepolia testnet address */
        sepolia: string;
        /** Ethereum mainnet address */
        mainnet: string;
    };
    /** State Transition Verifier contract addresses */
    stateTransitionVerifierGroth16: {
        /** Sepolia testnet address */
        sepolia: string;
        /** Ethereum mainnet address */
        mainnet: string;
    };
    /** Results Verifier contract addresses */
    resultsVerifierGroth16: {
        /** Sepolia testnet address */
        sepolia: string;
        /** Ethereum mainnet address */
        mainnet: string;
    };
    /** Sequencer Registry contract addresses */
    sequencerRegistry: {
        /** Sepolia testnet address */
        sepolia: string;
        /** Ethereum mainnet address */
        mainnet: string;
    };
}

/**
 * Deployed contract addresses imported from @vocdoni/davinci-contracts package.
 * These addresses are used to interact with the Vocdoni voting protocol contracts
 * on different networks.
 */
export const deployedAddresses: DeployedAddresses = addressesJson;

/**
 * Enum representing the possible states of a transaction during its lifecycle.
 * Used to track and report transaction status in the event stream.
 */
export enum TxStatus {
    /** Transaction has been submitted and is waiting to be mined */
    Pending = "pending",
    /** Transaction has been successfully mined and executed */
    Completed = "completed",
    /** Transaction was mined but reverted during execution */
    Reverted = "reverted",
    /** Transaction failed before or during submission */
    Failed = "failed",
}

/**
 * Union type representing the different events that can occur during a transaction's lifecycle.
 * Each event includes relevant data based on the transaction status.
 * 
 * @template T - The type of the successful response data
 */
export type TxStatusEvent<T = any> =
    | { status: TxStatus.Pending; hash: string }
    | { status: TxStatus.Completed; response: T }
    | { status: TxStatus.Reverted; reason?: string }
    | { status: TxStatus.Failed; error: Error };

/**
 * Abstract base class providing common functionality for smart contract interactions.
 * Implements transaction handling, status monitoring, and event normalization.
 */
export abstract class SmartContractService {
    /**
     * Sends a transaction and yields status events during its lifecycle.
     * This method handles the complete transaction flow from submission to completion,
     * including error handling and status updates.
     * 
     * @template T - The type of the successful response data
     * @param txPromise - Promise resolving to the transaction response
     * @param responseHandler - Function to process the successful transaction result
     * @returns AsyncGenerator yielding transaction status events
     * 
     * @example
     * ```typescript
     * const txStream = await this.sendTx(
     *   contract.someMethod(),
     *   async () => await contract.getUpdatedValue()
     * );
     * 
     * for await (const event of txStream) {
     *   switch (event.status) {
     *     case TxStatus.Pending:
     *       console.log(`Transaction pending: ${event.hash}`);
     *       break;
     *     case TxStatus.Completed:
     *       console.log(`Transaction completed:`, event.response);
     *       break;
     *   }
     * }
     * ```
     */
    protected async *sendTx<T>(
        txPromise: Promise<ContractTransactionResponse>,
        responseHandler: () => Promise<T>
    ): AsyncGenerator<TxStatusEvent<T>, void, unknown> {
        try {
            const tx = await txPromise;
            yield { status: TxStatus.Pending, hash: tx.hash };

            const receipt = await tx.wait();

            if (!receipt) {
                yield { status: TxStatus.Reverted, reason: "Transaction was dropped or not mined." };
            } else if (receipt.status === 0) {
                yield { status: TxStatus.Reverted, reason: "Transaction reverted." };
            } else {
                const result = await responseHandler();
                yield { status: TxStatus.Completed, response: result };
            }
        } catch (err: any) {
            yield {
                status: TxStatus.Failed,
                error: err instanceof Error ? err : new Error("Unknown transaction error"),
            };
        }
    }

    /**
     * Executes a transaction stream and returns the result or throws an error.
     * This is a convenience method that processes a transaction stream and either
     * returns the successful result or throws an appropriate error.
     * 
     * @template T - The type of the successful response data
     * @param stream - AsyncGenerator of transaction status events
     * @returns Promise resolving to the successful response data
     * @throws Error if the transaction fails or reverts
     * 
     * @example
     * ```typescript
     * try {
     *   const result = await SmartContractService.executeTx(
     *     contract.someMethod()
     *   );
     *   console.log('Transaction successful:', result);
     * } catch (error) {
     *   console.error('Transaction failed:', error);
     * }
     * ```
     */
    static async executeTx<T>(
        stream: AsyncGenerator<TxStatusEvent<T>>
    ): Promise<T> {
        for await (const event of stream) {
            switch (event.status) {
                case TxStatus.Completed:
                    return event.response;
                case TxStatus.Failed:
                    throw event.error;
                case TxStatus.Reverted:
                    throw new Error(`Transaction reverted: ${event.reason || "unknown reason"}`);
            }
        }
        throw new Error("Transaction stream ended unexpectedly");
    }

    /**
     * Normalizes event listener arguments between different ethers.js versions.
     * This helper method ensures consistent event argument handling regardless of
     * whether the event payload follows ethers v5 or v6 format.
     * 
     * @template Args - Tuple type representing the expected event arguments
     * @param callback - The event callback function to normalize
     * @returns Normalized event listener function
     * 
     * @example
     * ```typescript
     * contract.on('Transfer', this.normalizeListener((from: string, to: string, amount: BigInt) => {
     *   console.log(`Transfer from ${from} to ${to}: ${amount}`);
     * }));
     * ```
     */
    protected normalizeListener<Args extends any[]>(
        callback: (...args: Args) => void
    ): (...listenerArgs: any[]) => void {
        return (...listenerArgs: any[]) => {
            let args: any[];
            if (listenerArgs.length === 1 && listenerArgs[0]?.args) {
                args = listenerArgs[0].args;
            } else {
                args = listenerArgs;
            }
            callback(...(args as Args));
        };
    }
}
