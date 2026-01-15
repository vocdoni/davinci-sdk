import { DavinciCrypto, DavinciCryptoInputs } from '../../../src/sequencer';
import { VocdoniSequencerService } from '../../../src/sequencer/SequencerService';
import { InfoResponse } from '../../../src/sequencer/api/types';
import { CensusOrigin } from '../../../src/census/';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from test/.env
config({ path: resolve(__dirname, '../../.env') });

describe('DavinciCryptoService Integration', () => {
  let service: DavinciCrypto;
  let api: VocdoniSequencerService;

  const example: DavinciCryptoInputs = {
    address: 'A62E32147e9c1EA76DA552Be6E0636F1984143AF',
    processID: 'A62E32147E9C1EA76DA552BE6E0636F1984143AFF3E601460000000000000035',
    encryptionKey: [
      '9893338637931860616720507408105297162588837225464624604186540472082423274495',
      '12595438123836047903232785676476920953357035744165788772034206819455277990072',
    ],
    k: '964256131946492867709099996647243890828558919187',
    ballotMode: {
      numFields: 5,
      uniqueValues: false,
      maxValue: '16',
      minValue: '0',
      maxValueSum: '1280',
      minValueSum: '5',
      costExponent: 2,
      costFromWeight: false,
    },
    weight: '10',
    fieldValues: ['14', '9', '8', '9', '0', '0', '0', '0'],
  };

  beforeAll(async () => {
    api = new VocdoniSequencerService(process.env.SEQUENCER_API_URL!);
    const info = await api.getInfo();

    service = new DavinciCrypto({
      wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
      wasmUrl: info.ballotProofWasmHelperUrl,
      // Include hashes for verification
      wasmExecHash: info.ballotProofWasmHelperExecJsHash,
      wasmHash: info.ballotProofWasmHelperHash,
    });
    await service.init();
  });

  it('should produce a complete DavinciCryptoOutput with all fields typed correctly', async () => {
    const out = await service.proofInputs(example);
    // --- top‐level strings ---
    expect(typeof out.processId).toBe('string');
    expect(typeof out.address).toBe('string');
    expect(typeof out.ballotInputsHash).toBe('string');
    expect(typeof out.voteId).toBe('string');

    expect(typeof out.ballot.curveType).toBe('string');
    expect(Array.isArray(out.ballot.ciphertexts)).toBe(true);
    out.ballot.ciphertexts.forEach(ct => {
      expect(Array.isArray(ct.c1)).toBe(true);
      expect(ct.c1).toHaveLength(2);
      ct.c1.forEach(x => expect(typeof x).toBe('string'));

      expect(Array.isArray(ct.c2)).toBe(true);
      expect(ct.c2).toHaveLength(2);
      ct.c2.forEach(x => expect(typeof x).toBe('string'));
    });

    const ci = out.circomInputs as Record<string, any>;
    expect(typeof ci).toBe('object');

    //const expectedPid = BigInt('0x' + example.processID).toString();
    //expect(ci.process_id).toBe(expectedPid);

    const hexAddr = example.address.startsWith('0x') ? example.address : '0x' + example.address;
    expect(ci.address).toBe(BigInt(hexAddr).toString());

    expect(ci.k).toBe(example.k);

    // Check for vote_id in circom inputs (new field)
    expect(typeof ci.vote_id).toBe('string');

    const fieldsArr = ci.fieldValues ?? ci.fields;
    expect(Array.isArray(fieldsArr)).toBe(true);
    expect(fieldsArr).toContain(example.fieldValues[0]);
  });

  it('should produce a complete DavinciCryptoOutput with all fields typed correctly without using k', async () => {
    const out = await service.proofInputs({ ...example, k: undefined });

    // --- top‐level strings ---
    expect(typeof out.processId).toBe('string');
    expect(typeof out.address).toBe('string');
    expect(typeof out.ballotInputsHash).toBe('string');
    expect(typeof out.voteId).toBe('string');

    expect(typeof out.ballot.curveType).toBe('string');
    expect(Array.isArray(out.ballot.ciphertexts)).toBe(true);
    out.ballot.ciphertexts.forEach(ct => {
      expect(Array.isArray(ct.c1)).toBe(true);
      expect(ct.c1).toHaveLength(2);
      ct.c1.forEach(x => expect(typeof x).toBe('string'));

      expect(Array.isArray(ct.c2)).toBe(true);
      expect(ct.c2).toHaveLength(2);
      ct.c2.forEach(x => expect(typeof x).toBe('string'));
    });

    const ci = out.circomInputs as Record<string, any>;
    expect(typeof ci).toBe('object');

    const hexAddr = example.address.startsWith('0x') ? example.address : '0x' + example.address;
    expect(ci.address).toBe(BigInt(hexAddr).toString());

    expect(typeof ci.k).toBe('string');

    // Check for vote_id in circom inputs (new field)
    expect(typeof ci.vote_id).toBe('string');

    const fieldsArr = ci.fieldValues ?? ci.fields;
    expect(Array.isArray(fieldsArr)).toBe(true);
    expect(fieldsArr).toContain(example.fieldValues[0]);
  });

  describe('CSP (Credential Service Provider) Functions', () => {
    const cspTestData = {
      censusOrigin: CensusOrigin.CSP, // CSP origin type
      privKey:
        '50df49d9d1175d49808602d12bf945ba3f55d90146882fbc5d54078f204f5005372143904f3fd452767581fd55b4c27aedacdd7b70d14f374b7c9f341c0f9a5300',
      processId: '00000539f39fd6e51aad88f6f4ce6ab8827279cfffb922660000000000000000',
      address: '0e9eA11b92F119aEce01990b68d85227a41AA627',
      weight: '10',
    };

    describe('CSP Signing and Verification', () => {
      it('should generate a CSP signature and return valid proof', async () => {
        const cspProof = await service.cspSign(
          cspTestData.censusOrigin,
          cspTestData.privKey,
          cspTestData.processId,
          cspTestData.address,
          cspTestData.weight
        );

        // Verify the proof is a valid object with expected structure
        expect(typeof cspProof).toBe('object');
        expect(cspProof).not.toBeNull();

        // The proof should contain expected fields
        expect(cspProof).toHaveProperty('signature');
        expect(cspProof).toHaveProperty('publicKey');
        expect(cspProof).toHaveProperty('censusOrigin');
        expect(cspProof).toHaveProperty('root');
        expect(cspProof).toHaveProperty('address');
        expect(cspProof).toHaveProperty('processId');
      });

      it('should verify a valid CSP proof', async () => {
        // First generate a proof
        const cspProof = await service.cspSign(
          cspTestData.censusOrigin,
          cspTestData.privKey,
          cspTestData.processId,
          cspTestData.address,
          cspTestData.weight
        );

        // Then verify it
        const isValid = await service.cspVerify(
          cspProof.censusOrigin,
          cspProof.root,
          cspProof.address,
          cspProof.weight,
          cspProof.processId,
          cspProof.publicKey,
          cspProof.signature
        );
        expect(typeof isValid).toBe('boolean');
        expect(isValid).toBe(true);
      });

      it('should reject an invalid CSP proof', async () => {
        // The Go/WASM implementation throws an error for invalid proofs
        await expect(
          service.cspVerify(
            CensusOrigin.CSP,
            'invalid_root',
            'invalid_address',
            'invalid_weight',
            'invalid_process_id',
            'invalid_public_key',
            'invalid_signature'
          )
        ).rejects.toThrow();
      });

      it('should handle invalid parameters in cspVerify gracefully', async () => {
        // This should either throw an error or return false, depending on implementation
        try {
          const result = await service.cspVerify(
            CensusOrigin.CSP,
            'malformed_root',
            'malformed_address',
            'malformed_weight',
            'malformed_process_id',
            'malformed_public_key',
            'malformed_signature'
          );
          expect(typeof result).toBe('boolean');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      });
    });

    describe('CSP Census Root Generation', () => {
      it('should generate a CSP census root and return valid hexadecimal string', async () => {
        const censusRoot = await service.cspCensusRoot(
          cspTestData.censusOrigin,
          cspTestData.privKey
        );

        // Verify the result is a string and a valid hex string
        expect(typeof censusRoot).toBe('string');
        expect(censusRoot.length).toBeGreaterThan(0);
        expect(censusRoot).toMatch(/^0x[0-9a-fA-F]+$/);
      });

      it('should generate consistent census root for same inputs', async () => {
        const censusRoot1 = await service.cspCensusRoot(
          cspTestData.censusOrigin,
          cspTestData.privKey
        );

        const censusRoot2 = await service.cspCensusRoot(
          cspTestData.censusOrigin,
          cspTestData.privKey
        );

        // Same inputs should produce same output
        expect(censusRoot1).toBe(censusRoot2);
      });

      it('should generate different census roots for different private keys', async () => {
        const differentPrivKey =
          '60df49d9d1175d49808602d12bf945ba3f55d90146882fbc5d54078f204f5005372143904f3fd452767581fd55b4c27aedacdd7b70d14f374b7c9f341c0f9a5301';

        const censusRoot1 = await service.cspCensusRoot(
          cspTestData.censusOrigin,
          cspTestData.privKey
        );

        const censusRoot2 = await service.cspCensusRoot(cspTestData.censusOrigin, differentPrivKey);

        // Different private keys should produce different outputs
        expect(censusRoot1).not.toBe(censusRoot2);
      });
    });

    describe('Error Handling and Edge Cases', () => {
      it('should throw error when cspSign is called before initialization', async () => {
        const uninitializedService = new DavinciCrypto({
          wasmExecUrl: 'dummy_url',
          wasmUrl: 'dummy_url',
        });

        await expect(
          uninitializedService.cspSign(
            cspTestData.censusOrigin,
            cspTestData.privKey,
            cspTestData.processId,
            cspTestData.address,
            cspTestData.weight
          )
        ).rejects.toThrow('DavinciCrypto not initialized');
      });

      it('should throw error when cspVerify is called before initialization', async () => {
        const uninitializedService = new DavinciCrypto({
          wasmExecUrl: 'dummy_url',
          wasmUrl: 'dummy_url',
        });

        await expect(
          uninitializedService.cspVerify(
            CensusOrigin.CSP,
            'test_root',
            'test_address',
            'test_weight',
            'test_process_id',
            'test_public_key',
            'test_signature'
          )
        ).rejects.toThrow('DavinciCrypto not initialized');
      });

      it('should throw error when cspCensusRoot is called before initialization', async () => {
        const uninitializedService = new DavinciCrypto({
          wasmExecUrl: 'dummy_url',
          wasmUrl: 'dummy_url',
        });

        await expect(
          uninitializedService.cspCensusRoot(cspTestData.censusOrigin, cspTestData.privKey)
        ).rejects.toThrow('DavinciCrypto not initialized');
      });

      it('should handle invalid private key format gracefully', async () => {
        const invalidPrivKey = 'invalid_private_key';

        // This should throw an error for invalid private key
        await expect(
          service.cspCensusRoot(cspTestData.censusOrigin, invalidPrivKey)
        ).rejects.toThrow();
      });

      it('should handle empty private key gracefully', async () => {
        const emptyPrivKey = '';

        // The Go/WASM implementation may handle empty private key by returning a result
        // rather than throwing an error, so we test for either behavior
        try {
          const result = await service.cspCensusRoot(cspTestData.censusOrigin, emptyPrivKey);

          // If it doesn't throw, verify it returns a valid string
          expect(typeof result).toBe('string');
          expect(result.length).toBeGreaterThan(0);
        } catch (error) {
          // If it throws an error, that's also acceptable behavior
          expect(error).toBeInstanceOf(Error);
        }
      });
    });

    describe('Census Origin Types', () => {
      it('should handle different census origin types for signing', async () => {
        // Test with different census origin values
        const origins = [CensusOrigin.OffchainStatic, CensusOrigin.CSP];

        for (const origin of origins) {
          if (origin === CensusOrigin.CSP) {
            // Only test CSP origin for now
            const cspProof = await service.cspSign(
              origin,
              cspTestData.privKey,
              cspTestData.processId,
              cspTestData.address,
              cspTestData.weight
            );

            expect(typeof cspProof).toBe('object');
            expect(cspProof).not.toBeNull();

            const isValid = await service.cspVerify(
              cspProof.censusOrigin,
              cspProof.root,
              cspProof.address,
              cspProof.weight,
              cspProof.processId,
              cspProof.publicKey,
              cspProof.signature
            );
            expect(isValid).toBe(true);
          }
        }
      });

      it('should handle different census origin types for census root', async () => {
        // Test with different census origin values
        const origins = [CensusOrigin.OffchainStatic, CensusOrigin.CSP];

        for (const origin of origins) {
          if (origin === CensusOrigin.CSP) {
            // Only test CSP origin for now
            const censusRoot = await service.cspCensusRoot(origin, cspTestData.privKey);

            expect(typeof censusRoot).toBe('string');
            expect(censusRoot.length).toBeGreaterThan(0);

            // Verify it's a valid hex string
            expect(censusRoot).toMatch(/^0x[0-9a-fA-F]+$/);
          }
        }
      });
    });
  });

  describe('Hash Verification', () => {
    let api: VocdoniSequencerService;
    let info: InfoResponse;

    beforeAll(async () => {
      api = new VocdoniSequencerService(process.env.SEQUENCER_API_URL!);
      info = await api.getInfo();
    });

    it('should initialize successfully with valid hashes', async () => {
      const serviceWithHashes = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
        wasmUrl: info.ballotProofWasmHelperUrl,
        wasmExecHash: info.ballotProofWasmHelperExecJsHash,
        wasmHash: info.ballotProofWasmHelperHash,
      });

      // Should not throw an error
      await expect(serviceWithHashes.init()).resolves.not.toThrow();
    });

    it('should work without hash verification (backward compatibility)', async () => {
      const serviceWithoutHashes = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
        wasmUrl: info.ballotProofWasmHelperUrl,
        // No hashes provided
      });

      // Should not throw an error
      await expect(serviceWithoutHashes.init()).resolves.not.toThrow();
    });

    it('should throw error with invalid wasm exec hash', async () => {
      // Use a different URL to avoid cache conflicts
      const serviceWithInvalidExecHash = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl + '?test=invalid_exec',
        wasmUrl: info.ballotProofWasmHelperUrl + '?test=invalid_exec',
        wasmExecHash: 'invalid_hash_value_that_will_not_match_the_actual_file_content',
        wasmHash: info.ballotProofWasmHelperHash,
      });

      await expect(serviceWithInvalidExecHash.init()).rejects.toThrow(
        /Hash verification failed for wasm_exec\.js/
      );
    });

    it('should throw error with invalid wasm binary hash', async () => {
      // Use a different URL to avoid cache conflicts
      const serviceWithInvalidWasmHash = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl + '?test=invalid_wasm',
        wasmUrl: info.ballotProofWasmHelperUrl + '?test=invalid_wasm',
        wasmExecHash: info.ballotProofWasmHelperExecJsHash,
        wasmHash: 'invalid_hash_value_that_will_not_match_the_actual_file_content',
      });

      await expect(serviceWithInvalidWasmHash.init()).rejects.toThrow(
        /Hash verification failed for davinci_crypto\.wasm/
      );
    });

    it('should provide detailed error message on hash mismatch', async () => {
      // Use a different URL to avoid cache conflicts
      const serviceWithInvalidHash = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl + '?test=detailed_error',
        wasmUrl: info.ballotProofWasmHelperUrl + '?test=detailed_error',
        wasmExecHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      });

      try {
        await serviceWithInvalidHash.init();
        throw new Error('Expected hash verification to fail');
      } catch (error: any) {
        expect(error.message).toContain('Hash verification failed for wasm_exec.js');
        expect(error.message).toContain(
          'Expected: deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
        );
        expect(error.message).toContain('Computed:');
      }
    });

    it('should handle case-insensitive hash comparison', async () => {
      // Get the actual hash and convert to uppercase
      const upperCaseHash = info.ballotProofWasmHelperExecJsHash.toUpperCase();

      const serviceWithUpperCaseHash = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
        wasmUrl: info.ballotProofWasmHelperUrl,
        wasmExecHash: upperCaseHash,
        wasmHash: info.ballotProofWasmHelperHash,
      });

      // Should not throw an error even with uppercase hash
      await expect(serviceWithUpperCaseHash.init()).resolves.not.toThrow();
    });

    it('should verify only provided hashes (partial verification)', async () => {
      // Test with only wasm exec hash provided
      const serviceWithOnlyExecHash = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
        wasmUrl: info.ballotProofWasmHelperUrl,
        wasmExecHash: info.ballotProofWasmHelperExecJsHash,
        // wasmHash intentionally omitted
      });

      await expect(serviceWithOnlyExecHash.init()).resolves.not.toThrow();

      // Test with only wasm binary hash provided
      const serviceWithOnlyWasmHash = new DavinciCrypto({
        wasmExecUrl: info.ballotProofWasmHelperExecJsUrl,
        wasmUrl: info.ballotProofWasmHelperUrl,
        wasmHash: info.ballotProofWasmHelperHash,
        // wasmExecHash intentionally omitted
      });

      await expect(serviceWithOnlyWasmHash.init()).resolves.not.toThrow();
    });
  });
});
