import { BallotProof, BallotProofInputs } from '../../../src/sequencer';

describe('BallotProof caching', () => {
    let service: BallotProof;
    let fetchSpy: jest.SpyInstance;

    // Mock Go runtime
    const mockGo = {
        importObject: {},
        run: jest.fn().mockImplementation(() => {
            const promise = Promise.resolve();
            // Ensure the promise has a catch method that returns the promise
            promise.catch = () => promise;
            return promise;
        })
    };

    // Mock instance for WebAssembly
    const mockInstance = {
        exports: {
            memory: new WebAssembly.Memory({ initial: 256 }),
            add: (a: number, b: number) => a + b
        }
    };

    // Mock BallotProofWasm with proper return value
    const mockBallotProofWasm = {
        proofInputs: jest.fn().mockImplementation((inputJson: string) => {
            return {
                error: null,
                data: JSON.stringify({
                    processID: '0x456',
                    address: '0x123',
                    commitment: 'mock-commitment',
                    nullifier: 'mock-nullifier',
                    ballot: {
                        curveType: 'mock-curve',
                        ciphertexts: []
                    },
                    ballotInputHash: 'mock-hash',
                    voteID: 'mock-vote-id',
                    circomInputs: {}
                })
            };
        })
    };

    // Minimal test inputs
    const testInputs: BallotProofInputs = {
        address: '0x123',
        processID: '0x456',
        secret: '789',
        encryptionKey: ['1', '2'],
        k: '3',
        weight: '4',
        fieldValues: ['5'],
        ballotMode: {
            maxCount: 1,
            forceUniqueness: false,
            maxValue: '10',
            minValue: '0',
            maxTotalCost: '10',
            minTotalCost: '0',
            costExponent: 1,
            costFromWeight: false
        }
    };

    beforeEach(() => {
        // Reset all mocks and clear caches
        jest.resetAllMocks();
        BallotProof['wasmExecCache'].clear();
        BallotProof['wasmBinaryCache'].clear();

        // Spy on fetch before mocking
        fetchSpy = jest.spyOn(global, 'fetch');

        // Mock fetch responses
        fetchSpy.mockImplementation((url: string) => {
            if (url.endsWith('wasm_exec.js')) {
                return Promise.resolve({
                    ok: true,
                    text: () => Promise.resolve('/* mock wasm_exec.js */')
                });
            } else if (url.endsWith('ballotproof.wasm')) {
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(new ArrayBuffer(256))
                });
            }
            return Promise.reject(new Error(`Unexpected URL: ${url}`));
        });

        // Mock WebAssembly.instantiate
        global.WebAssembly = {
            ...global.WebAssembly,
            instantiate: jest.fn().mockResolvedValue({ instance: mockInstance })
        } as any;

        // Mock global Go constructor
        global.Go = jest.fn().mockImplementation(() => mockGo) as any;

        // Mock global BallotProofWasm
        Object.defineProperty(global, 'BallotProofWasm', {
            value: mockBallotProofWasm,
            writable: true,
            configurable: true
        });

        // Create a fresh instance for each test
        service = new BallotProof({
            wasmExecUrl: 'http://example.com/wasm_exec.js',
            wasmUrl: 'http://example.com/ballotproof.wasm'
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should cache wasm_exec.js and ballotproof.wasm after first init()', async () => {
        // First initialization should fetch both files
        await service.init();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/wasm_exec.js');
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/ballotproof.wasm');

        // Reset spy counts
        jest.clearAllMocks();

        // Create new instance with same URLs
        const service2 = new BallotProof({
            wasmExecUrl: 'http://example.com/wasm_exec.js',
            wasmUrl: 'http://example.com/ballotproof.wasm'
        });

        // Second initialization should use cached files
        await service2.init();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should fetch new files for different URLs', async () => {
        // First initialization with original URLs
        await service.init();
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        jest.clearAllMocks();

        // Create new instance with different URLs
        const service2 = new BallotProof({
            wasmExecUrl: 'http://example.com/different_wasm_exec.js',
            wasmUrl: 'http://example.com/different_ballotproof.wasm'
        });

        // Should fetch new files
        await service2.init();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different_wasm_exec.js');
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different_ballotproof.wasm');
    });

    it('should handle fetch failures appropriately', async () => {
        // Mock fetch to fail for wasm_exec.js
        fetchSpy.mockImplementation((url: string) => {
            if (url.endsWith('wasm_exec.js')) {
                return Promise.resolve({ ok: false });
            }
            return Promise.resolve({
                ok: true,
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(4))
            });
        });

        try {
            await service.init();
            throw new Error('Should have thrown an error');
        } catch (error: any) {
            expect(error.message).toContain('Failed to fetch wasm_exec.js');
        }
    });

    it('should cache files independently', async () => {
        // First initialization caches both files
        await service.init();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        
        jest.clearAllMocks();

        // Create new instance with only different wasmExecUrl
        const service2 = new BallotProof({
            wasmExecUrl: 'http://example.com/different_wasm_exec.js',
            wasmUrl: 'http://example.com/ballotproof.wasm'
        });

        // Should only fetch the new wasm_exec.js
        await service2.init();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different_wasm_exec.js');
        
        jest.clearAllMocks();

        // Create new instance with only different wasmUrl
        const service3 = new BallotProof({
            wasmExecUrl: 'http://example.com/wasm_exec.js',
            wasmUrl: 'http://example.com/different_ballotproof.wasm'
        });

        // Should only fetch the new ballotproof.wasm
        await service3.init();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith('http://example.com/different_ballotproof.wasm');
    });
});
