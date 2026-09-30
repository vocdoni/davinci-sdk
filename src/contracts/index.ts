/**
 * The contracts layer: the `ProcessRegistry` (reads, organizer writes as
 * transaction status streams, events, the deployment pin check), census
 * contracts of origin 3, the write argument builders and the vendored ABIs
 * with revert decoding. Exported from the package root; the `DavinciSDK`
 * facade covers the usual flows.
 *
 * @example
 * ```typescript
 * import { JsonRpcProvider } from 'ethers';
 * import { GNOSIS, ProcessRegistryService } from '@vocdoni/davinci-sdk';
 *
 * const registry = new ProcessRegistryService(GNOSIS.processRegistry, new JsonRpcProvider(rpcUrl));
 * const process = await registry.getProcess(processId);
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

/**
 * Census contracts of origin-3 processes (davinci-onchain-census-contract).
 * @see {@link OnchainCensusService}
 */
export * from './OnchainCensusService';

/**
 * Builders of the registry's write arguments (DKG key mode parameters,
 * metadata hash).
 * @see {@link params}
 */
export * from './params';

/**
 * Vendored contract ABIs and DAVINCI revert decoding.
 * @see {@link abis}
 */
export * from './abis';
