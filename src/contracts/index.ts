/**
 * @module @vocdoni/davinci-sdk-contracts
 * 
 * Smart contract interaction layer for the Vocdoni voting protocol.
 * This package provides TypeScript classes for interacting with Vocdoni's Ethereum smart contracts.
 * 
 * Key features:
 * - Organization management through OrganizationRegistry
 * - Voting process management through ProcessRegistryService
 * - Transaction lifecycle management and status monitoring
 * - TypeScript support with full type definitions
 * - Compatible with ethers.js v6
 * 
 * @example
 * Basic usage:
 * ```typescript
 * import { ethers } from 'ethers';
 * import { OrganizationRegistry, ProcessRegistryService } from '@vocdoni/davinci-sdk-contracts';
 * 
 * // Initialize provider
 * const provider = new ethers.JsonRpcProvider('YOUR_RPC_URL');
 * 
 * // Create organization registry instance
 * const orgRegistry = new OrganizationRegistry(provider);
 * 
 * // Create process registry instance
 * const processRegistry = new ProcessRegistryService(provider);
 * 
 * // Example: Create a new organization
 * const createOrgStream = orgRegistry.create({
 *   name: "My Organization",
 *   description: "Description of my organization"
 * });
 * 
 * // Handle the transaction
 * try {
 *   const result = await SmartContractService.executeTx(createOrgStream);
 *   console.log("Organization created:", result);
 * } catch (error) {
 *   console.error("Failed to create organization:", error);
 * }
 * ```
 */

/**
 * Base class providing common functionality for smart contract interactions.
 * @see {@link SmartContractService}
 */
export * from './SmartContractService';

/**
 * Service for managing organizations on the Vocdoni protocol.
 * Provides methods for creating and updating organizations.
 * @see {@link OrganizationRegistry}
 */
export * from './OrganizationRegistry';

/**
 * Service for managing voting processes on the Vocdoni protocol.
 * Provides methods for creating and managing voting processes.
 * @see {@link ProcessRegistryService}
 */
export * from './ProcessRegistryService';
