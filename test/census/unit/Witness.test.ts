import {
  CensusOrigin,
  CensusWitnessError,
  OffchainCensus,
  checkCensusWitness,
  type MerkleCensusWitness,
} from '../../../src/census';

const PID = `0x${'ab'.repeat(31)}`;
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

async function setup() {
  const census = new OffchainCensus();
  census.add([A, { key: B, weight: 7 }, C]);
  const root = await census.root();
  return {
    census,
    root,
    process: { processId: PID, census: { origin: CensusOrigin.OffchainStatic, root } },
  };
}

describe('checkCensusWitness for a Merkle census', () => {
  it('returns the weight, and the proof when there is one', async () => {
    const { census, process } = await setup();
    const witness = await census.witness(B);
    expect(await checkCensusWitness(process, B.toUpperCase().replace('0X', '0x'), witness)).toEqual(
      {
        weight: 7n,
        censusProof: { type: 'merkle', ...witness.proof },
      }
    );
    expect(await checkCensusWitness(process, B, { type: 'merkle', weight: 7n })).toEqual({
      weight: 7n,
    });
    for (const origin of [CensusOrigin.OffchainDynamic, CensusOrigin.Onchain]) {
      await checkCensusWitness({ ...process, census: { ...process.census, origin } }, B, witness);
    }
  });

  it('pins the root for origins 1 and 2, not for an on-chain census', async () => {
    const { census, process } = await setup();
    const witness = await census.witness(A);
    const other = { ...process.census, root: 5n };
    await expect(checkCensusWitness({ ...process, census: other }, A, witness)).rejects.toThrow(
      'not for this voter and census'
    );
    await expect(
      checkCensusWitness(
        { ...process, census: { ...other, origin: CensusOrigin.OffchainDynamic } },
        A,
        witness
      )
    ).rejects.toThrow(CensusWitnessError);
    await checkCensusWitness(
      { ...process, census: { ...other, origin: CensusOrigin.Onchain } },
      A,
      witness
    );
  });

  it('refuses a proof of another member, another weight or a broken path', async () => {
    const { census, process } = await setup();
    const witness = (await census.witness(A)) as Required<MerkleCensusWitness>;
    const refuse = (address: string, w: MerkleCensusWitness) =>
      expect(checkCensusWitness(process, address, w)).rejects.toThrow(CensusWitnessError);
    await refuse(B, witness);
    await refuse(A, { ...witness, weight: 2n });
    await refuse(A, {
      ...witness,
      proof: { ...witness.proof, pathBits: witness.proof.pathBits ^ 1n },
    });
    await refuse(A, {
      ...witness,
      proof: { ...witness.proof, siblings: [...witness.proof.siblings, 1n] },
    });
    await refuse(A, { type: 'merkle', weight: 1n << 88n });
    await expect(
      checkCensusWitness(
        { ...process, census: { ...process.census, origin: CensusOrigin.CSP } },
        A,
        witness
      )
    ).rejects.toThrow('a Merkle witness for a census of origin 4');
  });
});
