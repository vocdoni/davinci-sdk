import { addressToField, buildBallot } from '../../../src/crypto';
import { bigIntToHex } from '../../../src/crypto/field';
import { BALLOT_VK_HASH } from '../../../src/protocol';
import { BallotProofError, BallotProver, verifyBallotProof } from '../../../src/prover';
import { loadFixture } from '../../helpers/fixtures';
import { REAL_PROOF, realProofBallot } from '../../helpers/realProof';

// The real circuit files: a davinci-circom checkout's `artifacts/` directory
// (e.g. DAVINCI_CIRCUIT_ARTIFACTS=/path/to/davinci-circom/artifacts). The
// proving key is 33 MB, so this suite runs only when it is set.
const DIR = process.env.DAVINCI_CIRCUIT_ARTIFACTS;

// davinci-zkvm rust-sdk/testdata/ballots.json: Go-built ballots and their 71 public signals.
interface BallotJson {
  process_id: string;
  address: string;
  k: string;
  weight: string;
  mode: {
    num_fields: number;
    group_size: number;
    unique_values: boolean;
    cost_exponent: number;
    max_value: string | number;
    min_value: string | number;
    max_value_sum: string | number;
    min_value_sum: string | number;
  };
  fields: (string | number)[];
  pk: { x: string; y: string };
  public_signals: string[];
}

describe.skipIf(!DIR)('BallotProver with the real circuit files', () => {
  const prover = new BallotProver({ artifacts: { dir: DIR } });

  afterAll(async () => {
    await BallotProver.terminate();
  });

  it('loads the pinned files: sha256s and both verification keys match', async () => {
    const files = await prover.load(BALLOT_VK_HASH);
    expect(files.zkey.length).toBe(32_648_690);
    expect(files.wasm.length).toBe(2_428_512);
    expect(files.vkey.IC).toHaveLength(72);
  }, 60_000);

  it('proves the ballot of the real proof, with its public signals', async () => {
    const ballot = await realProofBallot();
    const { proof, publicSignals } = await prover.prove(ballot, BALLOT_VK_HASH);
    expect(publicSignals).toEqual(REAL_PROOF.public_signals);
    expect(await verifyBallotProof(REAL_PROOF.vk, proof, publicSignals)).toBe(true);
  }, 120_000);

  // snarkjs numbers the public signals by declaration order in the circuit;
  // these are the ones the SDK derives, for padded and full ballots alike.
  it.each([1, 8])(
    'proves the Go ballot of %i fields with the signals the SDK and Go derive',
    async nf => {
      const b = loadFixture<BallotJson[]>('zkvm/ballots.json').find(
        x => x.mode.num_fields === nf
      ) as BallotJson;
      const built = await buildBallot({
        processId: bigIntToHex(BigInt(b.process_id), 31),
        address: `0x${b.address}`,
        encryptionKey: { x: BigInt(b.pk.x), y: BigInt(b.pk.y) },
        ballotMode: {
          numFields: b.mode.num_fields,
          groupSize: b.mode.group_size,
          uniqueValues: b.mode.unique_values,
          costExponent: b.mode.cost_exponent,
          maxValue: BigInt(b.mode.max_value),
          minValue: BigInt(b.mode.min_value),
          maxValueSum: BigInt(b.mode.max_value_sum),
          minValueSum: BigInt(b.mode.min_value_sum),
        },
        fields: b.fields.map(BigInt),
        weight: BigInt(b.weight),
        k: BigInt(b.k),
      });
      const { proof, publicSignals } = await prover.prove(built, BALLOT_VK_HASH);
      expect(publicSignals).toEqual(b.public_signals);
      expect(publicSignals[0]).toBe(addressToField(b.address).toString());
      expect(await verifyBallotProof(REAL_PROOF.vk, proof, publicSignals)).toBe(true);
    },
    120_000
  );

  it('proves a 16-field ballot, no field padded', async () => {
    const b = REAL_PROOF.ballot;
    const built = await buildBallot({
      processId: bigIntToHex(BigInt(b.process_id), 31),
      address: `0x${b.address}`,
      encryptionKey: { x: BigInt(b.pk.x), y: BigInt(b.pk.y) },
      ballotMode: {
        numFields: 16,
        groupSize: 1,
        uniqueValues: false,
        costExponent: 1,
        maxValue: 5n,
        minValue: 0n,
        maxValueSum: 80n,
        minValueSum: 0n,
      },
      fields: Array.from({ length: 16 }, (_, i) => BigInt(i % 6)),
      weight: 1n,
      k: 13579n,
    });
    const { proof, publicSignals } = await prover.prove(built, BALLOT_VK_HASH);
    expect(publicSignals).toHaveLength(71);
    expect(publicSignals).toEqual(built.publicSignals.map(String));
    expect(publicSignals.slice(67)).not.toEqual(['0', '1', '0', '1']);
    expect(await verifyBallotProof(REAL_PROOF.vk, proof, publicSignals)).toBe(true);
  }, 120_000);

  it('proves a fresh ballot', async () => {
    const ballot = await realProofBallot({ fields: [6n, 5n, 4n, 3n, 2n, 1n], k: 987654321n });
    const { proof, publicSignals } = await prover.prove(ballot, BALLOT_VK_HASH);
    expect(publicSignals).toEqual(ballot.publicSignals.map(String));
    expect(await verifyBallotProof(REAL_PROOF.vk, proof, publicSignals)).toBe(true);
  }, 120_000);

  it('cannot prove choices the ballot mode refuses', async () => {
    // maxValue is 16, so 17 has no witness.
    const ballot = await realProofBallot({ fields: [17n, 1n, 2n, 3n, 4n, 5n] });
    await expect(prover.prove(ballot, BALLOT_VK_HASH)).rejects.toThrow(BallotProofError);
  }, 120_000);
});
