import { CircomProof, ProofInputs, Groth16Proof } from '../../../src/sequencer';
import { groth16 } from 'snarkjs';
import { sha256 } from 'ethers';

// Mock snarkjs groth16
jest.mock('snarkjs', () => ({
    groth16: {
        fullProve: jest.fn().mockResolvedValue({
            proof: {
                pi_a: ['1', '2', '3'],
                pi_b: [['4', '5'], ['6', '7'], ['8', '9']],
                pi_c: ['10', '11', '12'],
                protocol: 'groth16',
                curve: 'bn128'
            },
            publicSignals: ['123']
        }),
        verify: jest.fn().mockResolvedValue(true)
    }
}));

describe('CircomProof caching', () => {
    let service: CircomProof;
    let fetchSpy: jest.SpyInstance;
    
    // Minimal inputs for testing
    const testInputs: ProofInputs = {
        fields: ['1'],
        num_fields: '1',
        unique_values: '0',
        max_value: '10',
        min_value: '0',
        max_value_sum: '10',
        min_value_sum: '0',
        cost_exponent: '0',
        cost_from_weight: '0',
        address: '1',
        weight: '1',
        process_id: '1',
        encryption_pubkey: ['1', '2'],
        k: '1',
        cipherfields: ['1'],
        vote_id: '1',
        inputs_hash: '1'
    };

    // Mock response for wasm file
    const mockWasmResponse = new Uint8Array([1, 2, 3, 4]);
    // Mock response for zkey file
    const mockZkeyResponse = new Uint8Array([5, 6, 7, 8]);

    beforeEach(() => {
        // Create a fresh instance for each test
        service = new CircomProof({
            wasmUrl: 'http://example.com/circuit.wasm',
            zkeyUrl: 'http://example.com/proving.zkey'
        });
        
        // Mock fetch to return our test responses
        global.fetch = jest.fn().mockImplementation((url: string) => {
            if (url.endsWith('.wasm')) {
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(mockWasmResponse.buffer)
                });
            } else if (url.endsWith('.zkey')) {
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(mockZkeyResponse.buffer)
                });
            }
            return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });

        // Spy on fetch after mocking
        fetchSpy = jest.spyOn(global, 'fetch');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should cache wasm and zkey files after first generate() call', async () => {
        // First call should fetch both files
        await service.generate(testInputs);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/circuit.wasm');
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/proving.zkey');

        // Verify groth16.fullProve was called with cached files
        expect(groth16.fullProve).toHaveBeenCalledWith(
            testInputs,
            expect.any(Uint8Array),
            expect.any(Uint8Array)
        );

        // Reset the spy counts
        jest.clearAllMocks();

        // Second call should use cached files (no new fetches)
        await service.generate(testInputs);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(groth16.fullProve).toHaveBeenCalledTimes(1);
    });

    it('should fetch new files when URLs change', async () => {
        // First call with original URLs
        await service.generate(testInputs);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        
        jest.clearAllMocks();

        // Call with different URLs should fetch new files
        await service.generate(testInputs, {
            wasmUrl: 'http://example.com/different.wasm',
            zkeyUrl: 'http://example.com/different.zkey'
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different.wasm');
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different.zkey');
    });

    it('should handle fetch failures appropriately', async () => {
        // Mock fetch to fail
        global.fetch = jest.fn().mockImplementation(() => 
            Promise.resolve({ ok: false, status: 404 })
        );

        await expect(service.generate(testInputs)).rejects.toThrow('Failed to fetch');
    });

    it('should cache files independently', async () => {
        // First call caches both files
        await service.generate(testInputs);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        
        jest.clearAllMocks();

        // Call with only new wasmUrl should fetch only wasm
        await service.generate(testInputs, {
            wasmUrl: 'http://example.com/different.wasm'
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different.wasm');
        
        jest.clearAllMocks();

        // Call with only new zkeyUrl should fetch only zkey
        await service.generate(testInputs, {
            zkeyUrl: 'http://example.com/different.zkey'
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different.zkey');
    });
});

describe('CircomProof hash verification', () => {
    let service: CircomProof;
    let fetchSpy: jest.SpyInstance;
    
    // Test data
    const mockWasmResponse = new Uint8Array([1, 2, 3, 4]);
    const mockZkeyResponse = new Uint8Array([5, 6, 7, 8]);
    const mockVkeyText = '{"mock": "verification_key"}';
    
    // Calculate expected hashes (remove 0x prefix to match implementation)
    const expectedWasmHash = sha256(mockWasmResponse).slice(2);
    const expectedZkeyHash = sha256(mockZkeyResponse).slice(2);
    const expectedVkeyHash = sha256(new TextEncoder().encode(mockVkeyText)).slice(2);
    
    const testInputs: ProofInputs = {
        fields: ['1'],
        num_fields: '1',
        unique_values: '0',
        max_value: '10',
        min_value: '0',
        max_value_sum: '10',
        min_value_sum: '0',
        cost_exponent: '0',
        cost_from_weight: '0',
        address: '1',
        weight: '1',
        process_id: '1',
        encryption_pubkey: ['1', '2'],
        k: '1',
        cipherfields: ['1'],
        vote_id: '1',
        inputs_hash: '1'
    };

    beforeEach(() => {
        // Mock fetch to return our test responses
        global.fetch = jest.fn().mockImplementation((url: string) => {
            if (url.endsWith('.wasm')) {
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(mockWasmResponse.buffer)
                });
            } else if (url.endsWith('.zkey')) {
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(mockZkeyResponse.buffer)
                });
            } else if (url.endsWith('.json')) {
                return Promise.resolve({
                    ok: true,
                    text: () => Promise.resolve('{"mock": "verification_key"}')
                });
            }
            return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });

        fetchSpy = jest.spyOn(global, 'fetch');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('generate() hash verification', () => {
        it('should verify wasm and zkey hashes when provided', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                wasmHash: expectedWasmHash,
                zkeyHash: expectedZkeyHash
            });

            await service.generate(testInputs);
            
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(groth16.fullProve).toHaveBeenCalledWith(
                testInputs,
                expect.any(Uint8Array),
                expect.any(Uint8Array)
            );
        });

        it('should work without hash verification (backward compatibility)', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey'
            });

            await service.generate(testInputs);
            
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(groth16.fullProve).toHaveBeenCalledWith(
                testInputs,
                expect.any(Uint8Array),
                expect.any(Uint8Array)
            );
        });

        it('should throw error when wasm hash verification fails', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                wasmHash: 'invalid_hash',
                zkeyHash: expectedZkeyHash
            });

            await expect(service.generate(testInputs)).rejects.toThrow(
                `Hash verification failed for circuit.wasm. Expected: invalid_hash, Computed: ${expectedWasmHash}`
            );
        });

        it('should throw error when zkey hash verification fails', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                wasmHash: expectedWasmHash,
                zkeyHash: 'invalid_hash'
            });

            await expect(service.generate(testInputs)).rejects.toThrow(
                `Hash verification failed for proving_key.zkey. Expected: invalid_hash, Computed: ${expectedZkeyHash}`
            );
        });

        it('should handle case-insensitive hash comparison', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                wasmHash: expectedWasmHash.toUpperCase(),
                zkeyHash: expectedZkeyHash.toLowerCase()
            });

            await service.generate(testInputs);
            
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(groth16.fullProve).toHaveBeenCalledWith(
                testInputs,
                expect.any(Uint8Array),
                expect.any(Uint8Array)
            );
        });

        it('should verify only provided hashes (partial verification)', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                wasmHash: expectedWasmHash
                // zkeyHash not provided - should not verify
            });

            await service.generate(testInputs);
            
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(groth16.fullProve).toHaveBeenCalledWith(
                testInputs,
                expect.any(Uint8Array),
                expect.any(Uint8Array)
            );
        });

        it('should not verify hashes for cached files', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                wasmHash: expectedWasmHash,
                zkeyHash: expectedZkeyHash
            });

            // First call - should verify hashes
            await service.generate(testInputs);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            
            jest.clearAllMocks();

            // Second call - should use cached files without hash verification
            await service.generate(testInputs);
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(groth16.fullProve).toHaveBeenCalledTimes(1);
        });
    });

    describe('verify() hash verification', () => {
        it('should verify vkey hash when provided', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                vkeyHash: expectedVkeyHash
            });

            const mockProof: Groth16Proof = {
                pi_a: ['1', '2', '3'],
                pi_b: [['4', '5'], ['6', '7'], ['8', '9']],
                pi_c: ['10', '11', '12'],
                protocol: 'groth16',
                curve: 'bn128'
            };

            const result = await service.verify(
                mockProof,
                ['123'],
                'http://example.com/verification.json'
            );
            
            expect(result).toBe(true);
            expect(fetchSpy).toHaveBeenCalledWith('http://example.com/verification.json');
        });

        it('should work without vkey hash verification (backward compatibility)', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey'
            });

            const mockProof: Groth16Proof = {
                pi_a: ['1', '2', '3'],
                pi_b: [['4', '5'], ['6', '7'], ['8', '9']],
                pi_c: ['10', '11', '12'],
                protocol: 'groth16',
                curve: 'bn128'
            };

            const result = await service.verify(
                mockProof,
                ['123'],
                'http://example.com/verification.json'
            );
            
            expect(result).toBe(true);
            expect(fetchSpy).toHaveBeenCalledWith('http://example.com/verification.json');
        });

        it('should throw error when vkey hash verification fails', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                vkeyHash: 'invalid_hash'
            });

            const mockProof: Groth16Proof = {
                pi_a: ['1', '2', '3'],
                pi_b: [['4', '5'], ['6', '7'], ['8', '9']],
                pi_c: ['10', '11', '12'],
                protocol: 'groth16',
                curve: 'bn128'
            };

            await expect(service.verify(
                mockProof,
                ['123'],
                'http://example.com/verification.json'
            )).rejects.toThrow(
                `Hash verification failed for verification_key.json. Expected: invalid_hash, Computed: ${expectedVkeyHash}`
            );
        });

        it('should handle case-insensitive vkey hash comparison', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                vkeyHash: expectedVkeyHash.toUpperCase()
            });

            const mockProof: Groth16Proof = {
                pi_a: ['1', '2', '3'],
                pi_b: [['4', '5'], ['6', '7'], ['8', '9']],
                pi_c: ['10', '11', '12'],
                protocol: 'groth16',
                curve: 'bn128'
            };

            const result = await service.verify(
                mockProof,
                ['123'],
                'http://example.com/verification.json'
            );
            
            expect(result).toBe(true);
            expect(fetchSpy).toHaveBeenCalledWith('http://example.com/verification.json');
        });

        it('should not verify hash for cached vkey files', async () => {
            service = new CircomProof({
                wasmUrl: 'http://example.com/circuit.wasm',
                zkeyUrl: 'http://example.com/proving.zkey',
                vkeyHash: expectedVkeyHash
            });

            const mockProof: Groth16Proof = {
                pi_a: ['1', '2', '3'],
                pi_b: [['4', '5'], ['6', '7'], ['8', '9']],
                pi_c: ['10', '11', '12'],
                protocol: 'groth16',
                curve: 'bn128'
            };

            // First call - should verify hash
            await service.verify(
                mockProof,
                ['123'],
                'http://example.com/verification.json'
            );
            expect(fetchSpy).toHaveBeenCalledWith('http://example.com/verification.json');
            
            jest.clearAllMocks();

            // Second call - should use cached file without hash verification
            await service.verify(
                mockProof,
                ['123'],
                'http://example.com/verification.json'
            );
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });
});
