import { Wallet } from 'ethers';
import { DavinciCSP } from '../../../src/sequencer/DavinciCSP';
import { CensusOrigin } from '../../../src/census/types';

describe('DavinciCSP', () => {
  const processId = '0x00000539f39fd6e51aad88f6f4ce6ab8827279cfffb922660000000000000000';
  const address = '0x0e9ea11b92f119aece01990b68d85227a41aa627';
  const weight = '10';

  it('requires init before use', async () => {
    const csp = new DavinciCSP();

    await expect(
      csp.cspSign(CensusOrigin.CSP, Wallet.createRandom().privateKey, processId, address, weight)
    ).rejects.toThrow('DavinciCSP not initialized');
  });

  it('generates deterministic census root for same seed', async () => {
    const csp = new DavinciCSP();
    await csp.init();

    const privKey = Wallet.createRandom().privateKey;
    const root1 = await csp.cspCensusRoot(CensusOrigin.CSP, privKey);
    const root2 = await csp.cspCensusRoot(CensusOrigin.CSP, privKey);

    expect(root1).toBe(root2);
    expect(root1).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('generates different census roots for different seeds', async () => {
    const csp = new DavinciCSP();
    await csp.init();

    const root1 = await csp.cspCensusRoot(CensusOrigin.CSP, Wallet.createRandom().privateKey);
    const root2 = await csp.cspCensusRoot(CensusOrigin.CSP, Wallet.createRandom().privateKey);

    expect(root1).not.toBe(root2);
  });

  it('signs and verifies CSP proofs', async () => {
    const csp = new DavinciCSP();
    await csp.init();

    const privKey = Wallet.createRandom().privateKey;
    const proof = await csp.cspSign(CensusOrigin.CSP, privKey, processId, address, weight);

    expect(proof.censusOrigin).toBe(CensusOrigin.CSP);
    expect(proof.root).toMatch(/^0x[0-9a-f]+$/i);
    expect(proof.publicKey).toMatch(/^0x[0-9a-f]+$/i);
    expect(proof.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(typeof proof.index).toBe('number');
    expect(Number.isInteger(proof.index)).toBe(true);
    expect(proof.index).toBeGreaterThanOrEqual(16);
    expect(proof.index).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);

    await expect(
      csp.cspVerify(
        proof.censusOrigin,
        proof.root,
        proof.address,
        proof.weight,
        proof.processId,
        proof.publicKey,
        proof.signature
      )
    ).resolves.toBe(true);
  });

  it('rejects proofs with wrong root', async () => {
    const csp = new DavinciCSP();
    await csp.init();

    const privKey = Wallet.createRandom().privateKey;
    const proof = await csp.cspSign(CensusOrigin.CSP, privKey, processId, address, weight);

    await expect(
      csp.cspVerify(
        proof.censusOrigin,
        '0x' + '00'.repeat(32),
        proof.address,
        proof.weight,
        proof.processId,
        proof.publicKey,
        proof.signature
      )
    ).resolves.toBe(false);
  });
});
