import { BALLOT_VK_HASH } from '../../../src/protocol';
import { BallotProofError, BallotProver, verifyBallotProof } from '../../../src/prover';
import { REAL_PROOF, realProofBallot } from '../../helpers/realProof';

// The real circuit files: a davinci-circom checkout's `artifacts/` directory
// (e.g. DAVINCI_CIRCUIT_ARTIFACTS=/path/to/davinci-circom/artifacts). The
// proving key is 35 MB, so this suite runs only when it is set.
const DIR = process.env.DAVINCI_CIRCUIT_ARTIFACTS;

describe.skipIf(!DIR)('BallotProver with the real circuit files', () => {
  const prover = new BallotProver({ artifacts: { dir: DIR } });

  afterAll(async () => {
    await BallotProver.terminate();
  });

  it('loads the pinned files: sha256s and both verification keys match', async () => {
    const files = await prover.load(BALLOT_VK_HASH);
    expect(files.zkey.length).toBe(37_228_548);
    expect(files.wasm.length).toBe(6_791_871);
  }, 60_000);

  it('proves the ballot of the real proof, with its public signals', async () => {
    const ballot = await realProofBallot();
    const { proof, publicSignals } = await prover.prove(ballot, BALLOT_VK_HASH);
    expect(publicSignals).toEqual(REAL_PROOF.public_signals);
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
