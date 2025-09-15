import { Signer, Wallet } from 'ethers';

/**
 * Creates the signature message for process creation.
 * @param processId - The process ID (with or without 0x prefix)
 * @returns The message string to be signed
 */
export function createProcessSignatureMessage(processId: string): string {
    // Remove 0x prefix if present and ensure lowercase
    const cleanProcessId = processId.replace(/^0x/, '').toLowerCase();
    return `I am creating a new voting process for the davinci.vote protocol identified with id ${cleanProcessId}`;
}

/**
 * Signs the process creation message with the provided signer.
 * @param processId - The process ID (with or without 0x prefix)
 * @param signer - The signer (Wallet or Signer) to sign with
 * @returns Promise resolving to the signature string
 */
export async function signProcessCreation(processId: string, signer: Signer | Wallet): Promise<string> {
    const message = createProcessSignatureMessage(processId);
    return await signer.signMessage(message);
}

/**
 * Validates that a process ID is a valid 64-character hex string (32 bytes).
 * @param processId - The process ID to validate
 * @returns True if valid, false otherwise
 */
export function validateProcessId(processId: string): boolean {
    // Check if it's a valid 64-character hex string (32 bytes)
    const cleanId = processId.replace(/^0x/, '');
    return /^[0-9a-fA-F]{64}$/.test(cleanId);
}
