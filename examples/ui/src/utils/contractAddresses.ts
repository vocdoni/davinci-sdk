import { deployedAddresses } from '@vocdoni/davinci-sdk'

/**
 * Validates if a string is a valid Ethereum address
 */
function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

/**
 * Gets the organization registry contract address
 * Uses environment variable if set and valid, otherwise falls back to deployed addresses
 */
export function getOrganizationRegistryAddress(): string {
  const envAddress = import.meta.env.ORGANIZATION_REGISTRY_ADDRESS

  if (envAddress && isValidAddress(envAddress)) {
    return envAddress
  }

  return deployedAddresses.organizationRegistry.sepolia
}

/**
 * Gets the process registry contract address
 * Uses environment variable if set and valid, otherwise falls back to deployed addresses
 */
export function getProcessRegistryAddress(): string {
  const envAddress = import.meta.env.PROCESS_REGISTRY_ADDRESS

  if (envAddress && isValidAddress(envAddress)) {
    return envAddress
  }

  return deployedAddresses.processRegistry.sepolia
}

/**
 * Gets both contract addresses
 */
export function getContractAddresses() {
  return {
    organizationRegistry: getOrganizationRegistryAddress(),
    processRegistry: getProcessRegistryAddress(),
  }
}
