import { deployedAddresses } from '@vocdoni/davinci-sdk'

/**
 * Validates if a string is a valid Ethereum address
 */
function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

/**
 * Gets the organization registry contract address
 * Uses sequencer info, environment variable, or falls back to deployed addresses
 */
export function getOrganizationRegistryAddress(sequencerContracts?: Record<string, string>): string {
  const forceSequencerAddresses = import.meta.env.FORCE_SEQUENCER_ADDRESSES === 'true'
  
  // Check if we should force using sequencer addresses
  if (forceSequencerAddresses && sequencerContracts?.organization) {
    if (isValidAddress(sequencerContracts.organization)) {
      console.info(`Using ORGANIZATION_REGISTRY_ADDRESS from sequencer info: ${sequencerContracts.organization}`)
      return sequencerContracts.organization
    } else {
      throw new Error(`Invalid organization registry address from sequencer: ${sequencerContracts.organization}`)
    }
  }
  
  // Check environment variable
  const envAddress = import.meta.env.ORGANIZATION_REGISTRY_ADDRESS
  if (envAddress && isValidAddress(envAddress)) {
    console.info(`Using ORGANIZATION_REGISTRY_ADDRESS from environment: ${envAddress}`)
    return envAddress
  }

  // Fallback to default
  console.info(`Using default organization registry address: ${deployedAddresses.organizationRegistry.sepolia}`)
  return deployedAddresses.organizationRegistry.sepolia
}

/**
 * Gets the process registry contract address
 * Uses sequencer info, environment variable, or falls back to deployed addresses
 */
export function getProcessRegistryAddress(sequencerContracts?: Record<string, string>): string {
  const forceSequencerAddresses = import.meta.env.FORCE_SEQUENCER_ADDRESSES === 'true'
  
  // Check if we should force using sequencer addresses
  if (forceSequencerAddresses && sequencerContracts?.process) {
    if (isValidAddress(sequencerContracts.process)) {
      console.info(`Using PROCESS_REGISTRY_ADDRESS from sequencer info: ${sequencerContracts.process}`)
      return sequencerContracts.process
    } else {
      throw new Error(`Invalid process registry address from sequencer: ${sequencerContracts.process}`)
    }
  }
  
  // Check environment variable
  const envAddress = import.meta.env.PROCESS_REGISTRY_ADDRESS
  if (envAddress && isValidAddress(envAddress)) {
    console.info(`Using PROCESS_REGISTRY_ADDRESS from environment: ${envAddress}`)
    return envAddress
  }

  // Fallback to default
  console.info(`Using default process registry address: ${deployedAddresses.processRegistry.sepolia}`)
  return deployedAddresses.processRegistry.sepolia
}

/**
 * Gets both contract addresses
 */
export function getContractAddresses(sequencerContracts?: Record<string, string>) {
  return {
    organizationRegistry: getOrganizationRegistryAddress(sequencerContracts),
    processRegistry: getProcessRegistryAddress(sequencerContracts),
  }
}

/**
 * Log the current configuration mode
 */
export function logAddressConfiguration(): void {
  const forceSequencerAddresses = import.meta.env.FORCE_SEQUENCER_ADDRESSES === 'true'
  
  if (forceSequencerAddresses) {
    console.info('FORCE_SEQUENCER_ADDRESSES is enabled - will use contract addresses from sequencer info endpoint')
  } else {
    console.info('FORCE_SEQUENCER_ADDRESSES is disabled - will use environment variables or default addresses')
  }
}
