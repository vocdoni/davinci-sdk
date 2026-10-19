import * as crypto from '../../../src/crypto';
import { BN254_FR, poseidon } from '../../../src/crypto';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/poseidon.json (go-iden3-crypto).
interface PoseidonCase {
  inputs: string[];
  output: string;
}

describe('Poseidon', () => {
  const cases = loadFixture<PoseidonCase[]>('zkvm/poseidon.json');

  it('matches go-iden3-crypto for every width 1..16', async () => {
    expect(cases).toHaveLength(64);
    expect(new Set(cases.map(c => c.inputs.length)).size).toBe(16);
    for (const c of cases) {
      expect(await poseidon(c.inputs.map(BigInt)), `width ${c.inputs.length}`).toBe(
        BigInt(c.output)
      );
    }
  });

  it('rejects 0 or more than 16 inputs and values not below p', async () => {
    await expect(poseidon([])).rejects.toThrow('1..16');
    await expect(poseidon(Array<bigint>(17).fill(1n))).rejects.toThrow('1..16');
    await expect(poseidon([BN254_FR])).rejects.toThrow('below p');
    await expect(poseidon([-1n])).rejects.toThrow('below p');
  });

  it('no longer exports MultiPoseidon: the ballot proof has no inputs hash', () => {
    expect(crypto).not.toHaveProperty('multiPoseidon');
  });
});
