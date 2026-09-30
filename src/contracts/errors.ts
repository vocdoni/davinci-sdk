/**
 * @fileoverview Standardized error classes for contract services
 *
 * This module provides a consistent error hierarchy for all contract service operations.
 * All errors extend from ContractServiceError and include operation context for better debugging.
 * A write that reverts, in its preflight or once mined, carries the decoded
 * custom error (registry, DKG adapter, DKG or verifier) in `revert`.
 */

import type { DavinciErrorDescription } from './abis';

/**
 * Abstract base class for all contract service errors.
 * Provides consistent error structure with operation context.
 */
export abstract class ContractServiceError extends Error {
  /**
   * Creates a new ContractServiceError instance.
   *
   * @param message - The error message describing what went wrong
   * @param operation - The operation that was being performed when the error occurred
   * @param revert - The custom error the call reverted with, when it decodes; for a
   *   rule the SDK checks before sending, the error the registry would revert with
   * @param cause - The underlying error
   */
  constructor(
    message: string,
    public readonly operation: string,
    public readonly revert?: DavinciErrorDescription,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  /**
   * Name of the custom error the call reverted with, or would have
   * (`InvalidStatus`, `GraceOpen`, ...).
   */
  get revertName(): string | undefined {
    return this.revert?.name;
  }
}

/**
 * Error thrown when process creation fails.
 */
export class ProcessCreateError extends ContractServiceError {}

/**
 * Error thrown when process status change fails.
 */
export class ProcessStatusError extends ContractServiceError {}

/**
 * Error thrown when process census update fails.
 */
export class ProcessCensusError extends ContractServiceError {}

/**
 * Error thrown when the census origin does not allow to modify the census root or uri
 * (only an off-chain dynamic census can be replaced).
 */
export class CensusNotUpdatable extends ContractServiceError {}

/**
 * Error thrown when a process metadata update fails.
 */
export class ProcessMetadataError extends ContractServiceError {}

/**
 * Error thrown when process duration change fails.
 */
export class ProcessDurationError extends ContractServiceError {}

/**
 * Error thrown when a max voters change fails.
 */
export class ProcessMaxVotersError extends ContractServiceError {}

/**
 * Error thrown when a grace window change fails.
 */
export class ProcessGraceError extends ContractServiceError {}

/**
 * Error thrown when revealing the organizer key of a DKG-locked process fails.
 */
export class ProcessKeyRevealError extends ContractServiceError {}

/**
 * Error thrown when finalizing DKG results fails.
 */
export class ProcessResultError extends ContractServiceError {}

/**
 * Error thrown when the registry holds no process with the given id.
 */
export class ProcessNotFoundError extends ContractServiceError {}

/**
 * Error thrown when a DKG key mode or read is used on a registry deployed
 * without a DKG manager (`dkgAdapter()` is zero).
 */
export class DkgDisabledError extends ContractServiceError {}

/**
 * The registry created `created`, not the id a sequencer key was issued for
 * (another `newProcess` from the same account landed first). No sequencer
 * holds that process's key: cancel it with `setProcessStatus(CANCELED)`.
 */
export class WrongProcessIdError extends ContractServiceError {
  /**
   * @param created - The process id the registry assigned
   * @param expected - The id the sequencer key was issued for
   */
  constructor(
    public readonly created: string,
    public readonly expected: string
  ) {
    super(
      `created process ${created}, but the key was issued for ${expected}; cancel it`,
      'newProcess'
    );
  }
}

/**
 * The deployment does not pin what this SDK release proves and verifies
 * (see `ProcessRegistryService.verifyDeployment`).
 */
export class DeploymentPinError extends ContractServiceError {
  /**
   * @param field - The registry getter (or check) that differs, e.g. `ballotVKHash`
   * @param expected - What this release pins
   * @param got - What the deployment reports
   */
  constructor(
    public readonly field: string,
    public readonly expected: string,
    public readonly got: string
  ) {
    super(`registry pin ${field}: expected ${expected}, got ${got}`, 'verifyDeployment');
  }
}

/**
 * A census contract call that failed, or a contract that is not an
 * append-only census of davinci-onchain-census-contract (davinci-zkvm branch).
 * A reverted write carries the contract's error (`SlotTaken`,
 * `AlreadyRegisteredAddress`, `InvalidCensusWeight`, ...) in `revert`.
 */
export class CensusContractError extends ContractServiceError {}
