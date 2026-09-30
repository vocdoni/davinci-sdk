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

export * from './SmartContractService';
export * from './errors';
export * from './types';
export * from './ProcessRegistryService';
export * from './OnchainCensusService';
export * from './params';
export * from './abis';
