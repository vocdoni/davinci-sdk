import { DavinciSDK, DavinciSDKConfig, MissingContractAddressesError } from "../../../src/core/DavinciSDK";
import { Wallet, JsonRpcProvider } from "ethers";

describe("DavinciSDK", () => {
    let mockSigner: Wallet;
    let mockConfig: DavinciSDKConfig;

    beforeEach(() => {
        const provider = new JsonRpcProvider("https://sepolia.infura.io/v3/test");
        mockSigner = new Wallet("0x1234567890123456789012345678901234567890123456789012345678901234", provider);
        
        mockConfig = {
            signer: mockSigner,
            sequencerUrl: "https://sequencer.test.com",
            censusUrl: "https://census.test.com",
            chain: "sepolia"
        };
    });

    describe("constructor", () => {
        it("should initialize with a signer", () => {
            const sdk = new DavinciSDK(mockConfig);
            expect(sdk).toBeInstanceOf(DavinciSDK);
        });

        it("should throw error if signer has no provider", () => {
            const signerWithoutProvider = Wallet.createRandom();
            const configWithBadSigner: DavinciSDKConfig = {
                ...mockConfig,
                signer: signerWithoutProvider
            };
            
            expect(() => new DavinciSDK(configWithBadSigner)).toThrow('Signer must have a provider attached');
        });

        it("should throw error if neither sequencerUrl nor censusUrl is provided", () => {
            const configWithoutUrls: DavinciSDKConfig = {
                signer: mockSigner,
                chain: "sepolia"
            };
            
            expect(() => new DavinciSDK(configWithoutUrls)).toThrow('At least one of sequencerUrl or censusUrl must be provided');
        });

        it("should initialize with only sequencerUrl", () => {
            const configWithOnlySequencer: DavinciSDKConfig = {
                signer: mockSigner,
                sequencerUrl: "https://sequencer.test.com",
                chain: "sepolia"
            };
            
            const sdk = new DavinciSDK(configWithOnlySequencer);
            expect(sdk).toBeInstanceOf(DavinciSDK);
            const services = sdk.getApiServices();
            expect(services.api.sequencer).toBeDefined();
            expect(services.api.census).toBeUndefined();
        });

        it("should initialize with only censusUrl", () => {
            const configWithOnlyCensus: DavinciSDKConfig = {
                signer: mockSigner,
                censusUrl: "https://census.test.com",
                chain: "sepolia"
            };
            
            const sdk = new DavinciSDK(configWithOnlyCensus);
            expect(sdk).toBeInstanceOf(DavinciSDK);
            const services = sdk.getApiServices();
            expect(services.api.census).toBeDefined();
            expect(services.api.sequencer).toBeUndefined();
        });

        it("should use default network when not specified", () => {
            const configWithoutChain = { ...mockConfig };
            delete configWithoutChain.chain;
            const sdk = new DavinciSDK(configWithoutChain);
            expect(sdk.getNetwork()).toBe("mainnet");
        });

        it("should accept any chain name", () => {
            const configWithCustomChain: DavinciSDKConfig = {
                ...mockConfig,
                chain: "polygon",
                contractAddresses: {
                    processRegistry: "0x1111111111111111111111111111111111111111"
                }
            };
            
            const sdk = new DavinciSDK(configWithCustomChain);
            expect(sdk.getNetwork()).toBe("polygon");
        });

        it("should throw error when no addresses are provided for unsupported chain", () => {
            const configWithUnsupportedChain: DavinciSDKConfig = {
                ...mockConfig,
                chain: "unsupported-chain"
            };
            
            expect(() => new DavinciSDK(configWithUnsupportedChain)).toThrow(MissingContractAddressesError);
            expect(() => new DavinciSDK(configWithUnsupportedChain)).toThrow(
                "No contract addresses found for chain 'unsupported-chain'"
            );
        });

        it("should work with custom addresses for unsupported chain", () => {
            const configWithCustomChain: DavinciSDKConfig = {
                ...mockConfig,
                chain: "unsupported-chain",
                contractAddresses: {
                    processRegistry: "0x1111111111111111111111111111111111111111"
                }
            };
            
            const sdk = new DavinciSDK(configWithCustomChain);
            expect(sdk.getNetwork()).toBe("unsupported-chain");
            expect(sdk.getContractAddresses().processRegistry).toBe("0x1111111111111111111111111111111111111111");
        });

        it("should use custom contract addresses when provided", () => {
            const customAddresses = {
                processRegistry: "0x1111111111111111111111111111111111111111",
                organizationRegistry: "0x2222222222222222222222222222222222222222",
                stateTransitionVerifier: "0x3333333333333333333333333333333333333333",
                resultsVerifier: "0x4444444444444444444444444444444444444444",
                sequencerRegistry: "0x5555555555555555555555555555555555555555"
            };

            const configWithCustomAddresses: DavinciSDKConfig = {
                ...mockConfig,
                contractAddresses: customAddresses
            };

            const sdk = new DavinciSDK(configWithCustomAddresses);
            const addresses = sdk.getContractAddresses();

            expect(addresses.processRegistry).toBe(customAddresses.processRegistry);
            expect(addresses.organizationRegistry).toBe(customAddresses.organizationRegistry);
            expect(addresses.stateTransitionVerifier).toBe(customAddresses.stateTransitionVerifier);
            expect(addresses.resultsVerifier).toBe(customAddresses.resultsVerifier);
            expect(addresses.sequencerRegistry).toBe(customAddresses.sequencerRegistry);
        });
    });

    describe("getAddress", () => {
        it("should return the signer address", async () => {
            const sdk = new DavinciSDK(mockConfig);
            const address = await sdk.getAddress();
            expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });
    });

    describe("getNetwork", () => {
        it("should return the configured network", () => {
            const sdk = new DavinciSDK(mockConfig);
            expect(sdk.getNetwork()).toBe("sepolia");
        });

        it("should return mainnet when configured", () => {
            const mainnetConfig: DavinciSDKConfig = {
                ...mockConfig,
                chain: "mainnet"
            };
            const mainnetSdk = new DavinciSDK(mainnetConfig);
            expect(mainnetSdk.getNetwork()).toBe("mainnet");
        });
    });

    describe("getContractAddresses", () => {
        it("should return all contract addresses", () => {
            const sdk = new DavinciSDK(mockConfig);
            const addresses = sdk.getContractAddresses();
            expect(addresses).toHaveProperty("processRegistry");
            expect(addresses).toHaveProperty("organizationRegistry");
            expect(addresses).toHaveProperty("stateTransitionVerifier");
            expect(addresses).toHaveProperty("resultsVerifier");
            expect(addresses).toHaveProperty("sequencerRegistry");
        });

        it("should return a copy of addresses (not reference)", () => {
            const sdk = new DavinciSDK(mockConfig);
            const addresses1 = sdk.getContractAddresses();
            const addresses2 = sdk.getContractAddresses();
            expect(addresses1).not.toBe(addresses2);
            expect(addresses1).toEqual(addresses2);
        });
    });

    describe("getApiServices", () => {
        it("should return all underlying services", () => {
            const sdk = new DavinciSDK(mockConfig);
            const services = sdk.getApiServices();
            expect(services).toHaveProperty("api");
            expect(services).toHaveProperty("processRegistry");
            expect(services).toHaveProperty("organizationRegistry");
            expect(services).toHaveProperty("provider");
            expect(services).toHaveProperty("signer");
        });
    });

    describe("ping", () => {
        it("should call the sequencer ping method when sequencer is available", async () => {
            const sdk = new DavinciSDK(mockConfig);
            const services = sdk.getApiServices();
            const pingSpy = jest.spyOn(services.api.sequencer!, "ping").mockResolvedValue(undefined);
            
            await sdk.ping();
            
            expect(pingSpy).toHaveBeenCalledTimes(1);
            pingSpy.mockRestore();
        });

        it("should throw error when sequencer is not available", async () => {
            const configWithoutSequencer: DavinciSDKConfig = {
                signer: mockSigner,
                censusUrl: "https://census.test.com",
                chain: "sepolia"
            };
            
            const sdk = new DavinciSDK(configWithoutSequencer);
            
            await expect(sdk.ping()).rejects.toThrow('Sequencer service is not available. Please provide a sequencerUrl in the configuration.');
        });
    });
});
