/**
 * Gets the explorer URL from environment variables
 * Falls back to Sepolia Etherscan if not set
 */
export function getExplorerUrl(): string {
  return process.env.EXPLORER_URL || 'https://sepolia.etherscan.io';
}

/**
 * Creates a transaction URL for the configured explorer
 */
export function getTransactionUrl(txHash: string): string {
  return `${getExplorerUrl()}/tx/${txHash}`;
}

/**
 * Creates an address URL for the configured explorer
 */
export function getAddressUrl(address: string): string {
  return `${getExplorerUrl()}/address/${address}`;
}
