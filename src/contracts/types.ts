/**
 * @fileoverview Standardized types and interfaces for contract services
 *
 * This module provides consistent type definitions for callbacks, interfaces,
 * and common data structures used across contract services.
 */

/**
 * Generic callback type for contract events.
 * @template T - Tuple type representing the event arguments
 */
export type EntityCallback<T extends any[]> = (...args: T) => void;

// ─── ORGANIZATION REGISTRY CALLBACKS ───────────────────────────────────────

/**
 * Callback for when an organization is created.
 * @param id - The organization ID
 */
export type OrganizationCreatedCallback = EntityCallback<[string]>;

/**
 * Callback for when an organization is updated.
 * @param id - The organization ID
 * @param updater - Address of the account that updated the organization
 */
export type OrganizationUpdatedCallback = EntityCallback<[string, string]>;

/**
 * Callback for when an administrator is added to an organization.
 * @param id - The organization ID
 * @param administrator - Address of the administrator that was added
 */
export type OrganizationAdministratorAddedCallback = EntityCallback<[string, string]>;

/**
 * Callback for when an administrator is removed from an organization.
 * @param id - The organization ID
 * @param administrator - Address of the administrator that was removed
 * @param remover - Address of the account that removed the administrator
 */
export type OrganizationAdministratorRemovedCallback = EntityCallback<[string, string, string]>;

// ─── PROCESS REGISTRY CALLBACKS ────────────────────────────────────────────

/**
 * Callback for when a process is created.
 * @param processID - The process ID
 * @param creator - Address of the account that created the process
 */
export type ProcessCreatedCallback = EntityCallback<[string, string]>;

/**
 * Callback for when a process status changes.
 * @param processID - The process ID
 * @param oldStatus - The previous status
 * @param newStatus - The new status
 */
export type ProcessStatusChangedCallback = EntityCallback<[string, bigint, bigint]>;

/**
 * Callback for when a process census is updated.
 * @param processID - The process ID
 * @param root - The new census root
 * @param uri - The new census URI
 */
export type ProcessCensusUpdatedCallback = EntityCallback<[string, string, string]>;

/**
 * Callback for when a process duration changes.
 * @param processID - The process ID
 * @param duration - The new duration
 */
export type ProcessDurationChangedCallback = EntityCallback<[string, bigint]>;

/**
 * Callback for when a process state root is updated.
 * @param processID - The process ID
 * @param sender - Address of the account that updated the state root
 * @param newStateRoot - The new state root
 */
export type ProcessStateRootUpdatedCallback = EntityCallback<[string, string, bigint]>;

/**
 * Callback for when process results are set.
 * @param processID - The process ID
 * @param sender - Address of the account that set the results
 * @param result - The results array
 */
export type ProcessResultsSetCallback = EntityCallback<[string, string, bigint[]]>;
