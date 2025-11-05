/**
 * Validates if a string is a valid Ethereum address
 */
function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

/**
 * Gets both contract addresses from sequencer
 * In v0.0.3+, contract addresses always come from the sequencer
 */
export function getContractAddresses(sequencerContracts: Record<string, string>) {
  if (!sequencerContracts?.organization || !sequencerContracts?.process) {
    throw new Error('Contract addresses not provided by sequencer')
  }

  if (!isValidAddress(sequencerContracts.organization)) {
    throw new Error(`Invalid organization registry address from sequencer: ${sequencerContracts.organization}`)
  }

  if (!isValidAddress(sequencerContracts.process)) {
    throw new Error(`Invalid process registry address from sequencer: ${sequencerContracts.process}`)
  }

  console.info('Using contract addresses from sequencer:')
  console.info(`  Organization Registry: ${sequencerContracts.organization}`)
  console.info(`  Process Registry: ${sequencerContracts.process}`)

  return {
    organizationRegistry: sequencerContracts.organization,
    processRegistry: sequencerContracts.process,
  }
}
