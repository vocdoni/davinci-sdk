import { BN254_FR, multiPoseidon, poseidon } from '../../../src/crypto';
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

  it('MultiPoseidon hashes 71 inputs in chunks of 16 (guest vector)', async () => {
    const inputs = Array.from({ length: 71 }, (_, i) => BigInt(i + 1));
    const chunks: bigint[] = [];
    for (let i = 0; i < 71; i += 16) chunks.push(await poseidon(inputs.slice(i, i + 16)));
    const h = await multiPoseidon(inputs);
    expect(h).toBe(await poseidon(chunks));
    // guest wide_tests::ballot_inputs_hash_matches_multihash, limbs most significant first.
    expect(h).toBe(0x057bfc2b042c36470fdddd04802ddbe42c3d2b8c7b372e69766291e2382e3ef5n);
  });

  it('MultiPoseidon of up to 16 inputs is a plain Poseidon, above 256 it recurses', async () => {
    const small = [5n, 6n, 7n];
    expect(await multiPoseidon(small)).toBe(await poseidon(small));
    const wide = Array.from({ length: 300 }, (_, i) => BigInt(i));
    const level1: bigint[] = [];
    for (let i = 0; i < 300; i += 16) level1.push(await poseidon(wide.slice(i, i + 16)));
    const level2: bigint[] = [];
    for (let i = 0; i < level1.length; i += 16)
      level2.push(await poseidon(level1.slice(i, i + 16)));
    expect(await multiPoseidon(wide)).toBe(await poseidon(level2));
  });
});
