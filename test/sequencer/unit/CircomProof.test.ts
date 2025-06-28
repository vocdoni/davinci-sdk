import { CircomProof, ProofInputs, Groth16Proof } from '../../../src/sequencer';
import { groth16 } from 'snarkjs';

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
        })
    }
}));

describe('CircomProof caching', () => {
    let service: CircomProof;
    let fetchSpy: jest.SpyInstance;
    
    // Minimal inputs for testing
    const testInputs: ProofInputs = {
        fields: ['1'],
        max_count: '1',
        force_uniqueness: '0',
        max_value: '10',
        min_value: '0',
        max_total_cost: '10',
        min_total_cost: '0',
        cost_exp: '0',
        cost_from_weight: '0',
        address: '1',
        weight: '1',
        process_id: '1',
        pk: ['1', '2'],
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
