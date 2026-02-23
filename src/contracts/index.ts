/**
 * @module @vocdoni/davinci-sdk-contracts
 *
 * Smart contract interaction layer for the Vocdoni voting protocol.
 * This package provides TypeScript classes for interacting with Vocdoni's Ethereum smart contracts.
 *
 * Key features:
 * - Voting process management through ProcessRegistryService
 * - Transaction lifecycle management and status monitoring
 * - TypeScript support with full type definitions
 * - Compatible with ethers.js v6
 *
 * @example
 * Basic usage:
 * ```typescript
 * import { ethers } from 'ethers';
 * import { ProcessRegistryService } from '@vocdoni/davinci-sdk-contracts';
 *
 * // Initialize provider
 * const provider = new ethers.JsonRpcProvider('YOUR_RPC_URL');
 *
 * // Create process registry instance
 * const processRegistry = new ProcessRegistryService(provider);
 * ```
 */

/**
 * Base class providing common functionality for smart contract interactions.
 * @see {@link SmartContractService}
 */
export * from './SmartContractService';

/**
 * Standardized error classes for contract service operations.
 * @see {@link errors}
 */
export * from './errors';

/**
 * Standardized type definitions for callbacks and interfaces.
 * @see {@link types}
 */
export * from './types';

/**
 * Service for managing voting processes on the Vocdoni protocol.
 * Provides methods for creating and managing voting processes.
 * @see {@link ProcessRegistryService}
 */
export * from './ProcessRegistryService';
