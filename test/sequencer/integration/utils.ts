import { Wallet, JsonRpcProvider } from "ethers";
import { Chain } from "@ethereumjs/common";

// Create mock provider and wallet
export const mockProvider = new JsonRpcProvider(process.env.SEPOLIA_RPC);
export const mockWallet = new Wallet(process.env.PRIVATE_KEY!, mockProvider);

// Mock data generators
export const generateMockCensusParticipants = (count: number) => {
    return Array.from({ length: count }, (_, i) => ({
        key: Wallet.createRandom().address,
        weight: ((i + 1) * 10).toString(),
    }));
};

export const generateMockProcessRequest = (censusRoot: string) => ({
    censusRoot,
    ballotMode: {
        maxCount: 1,
        maxValue: "10",
        minValue: "0",
        forceUniqueness: false,
        costFromWeight: false,
        costExponent: 0,
        maxTotalCost: "10",
        minTotalCost: "0"
    },
    nonce: 0,
    chainId: Chain.Sepolia
});

// UUID validator
export const isValidUUID = (str: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
};

// Hex validator
export const isValidHex = (str: string, length?: number): boolean => {
    const hexRegex = new RegExp(`^0x[a-fA-F0-9]${length ? `{${length}}` : '+'}$`);
    return hexRegex.test(str);
};
