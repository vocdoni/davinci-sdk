/**
 * @fileoverview Standardized error classes for contract services
 *
 * This module provides a consistent error hierarchy for all contract service operations.
 * All errors extend from ContractServiceError and include operation context for better debugging.
 */

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
   */
  constructor(
    message: string,
    public readonly operation: string
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ─── ORGANIZATION REGISTRY ERRORS ──────────────────────────────────────────

/**
 * Error thrown when organization creation fails.
 */
export class OrganizationCreateError extends ContractServiceError {}

/**
 * Error thrown when organization update fails.
 */
export class OrganizationUpdateError extends ContractServiceError {}

/**
 * Error thrown when organization deletion fails.
 */
export class OrganizationDeleteError extends ContractServiceError {}

/**
 * Error thrown when administrator operations fail.
 */
export class OrganizationAdministratorError extends ContractServiceError {}

// ─── PROCESS REGISTRY ERRORS ───────────────────────────────────────────────

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
 * Error thrown when the census origin does not allow to modify the census root or uri.
 */
export class CensusNotUpdatable extends ContractServiceError {}

/**
 * Error thrown when process duration change fails.
 */
export class ProcessDurationError extends ContractServiceError {}

/**
 * Error thrown when state transition submission fails.
 */
export class ProcessStateTransitionError extends ContractServiceError {}

/**
 * Error thrown when process result setting fails.
 */
export class ProcessResultError extends ContractServiceError {}
