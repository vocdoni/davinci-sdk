import { sha256, toUtf8Bytes } from 'ethers';
import * as snarkjs from 'snarkjs';
import { BALLOT_VK_HASH } from '../../../src/protocol';
import {
  ArtifactError,
  BALLOT_ARTIFACTS,
  BallotProofError,
  BallotProver,
  loadBallotArtifacts,
  verifyBallotProof,
  type BallotArtifactSet,
} from '../../../src/prover';
import type { Groth16Proof } from '../../../src/sequencer/types';
import { PINNED_VKEY_TEXT, REAL_PROOF, V1_VKEY, realProofBallot } from '../../helpers/realProof';

// Proving and the proving key's own VK are mocked (the real ones need the
// 35 MB zkey: RealProver.test.ts); verification is snarkjs' own.
vi.mock('snarkjs', async importOriginal => {
  const real = await importOriginal<typeof import('snarkjs')>();
  return {
    ...real,
    groth16: { ...real.groth16, fullProve: vi.fn() },
    zKey: { ...real.zKey, exportVerificationKey: vi.fn() },
  };
});

const fullProve = vi.mocked(snarkjs.groth16.fullProve);
const exportVk = vi.mocked(snarkjs.zKey.exportVerificationKey);

const WASM = toUtf8Bytes('stand-in witness wasm');
const ZKEY = toUtf8Bytes('stand-in proving key');
const VKEY = toUtf8Bytes(PINNED_VKEY_TEXT);
const PINNED_VK: unknown = JSON.parse(PINNED_VKEY_TEXT);

// The pinned key's entry with stand-in wasm and zkey files.
const ENTRY: BallotArtifactSet = {
  source: 'test',
  wasm: { url: 'https://files.example/ballot_proof.wasm', sha256: sha256(WASM) },
  zkey: { url: 'https://files.example/ballot_proof_pkey.zkey', sha256: sha256(ZKEY) },
  vkey: { ...BALLOT_ARTIFACTS[BALLOT_VK_HASH].vkey, url: 'https://files.example/vkey.json' },
};

function server() {
  const seen: string[] = [];
  const files: Record<string, Uint8Array> = {
    [ENTRY.wasm.url]: WASM,
    [ENTRY.zkey.url]: ZKEY,
    [ENTRY.vkey.url]: VKEY,
  };
  const fetchImpl = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const body = files[url];
    return Promise.resolve(body ? new Response(body) : new Response('', { status: 404 }));
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const artifacts = (fetchImpl: typeof fetch) => ({
  table: { [BALLOT_VK_HASH]: ENTRY },
  fetchImpl,
});

// snarkjs' answer for the real proof's inputs.
const PROVED = {
  proof: { ...REAL_PROOF.proof, curve: 'bn128' },
  publicSignals: REAL_PROOF.public_signals,
};

// Valid points, but not a proof: pi_a and pi_c swapped.
const SWAPPED = { ...PROVED.proof, pi_a: PROVED.proof.pi_c, pi_c: PROVED.proof.pi_a };

afterAll(async () => {
  await BallotProver.terminate();
});

beforeEach(() => {
  fullProve.mockReset();
  exportVk.mockReset();
  exportVk.mockResolvedValue(PINNED_VK);
});

describe('verifyBallotProof', () => {
  it('verifies the real proof under the pinned key, and nothing else', async () => {
    const vk = REAL_PROOF.vk;
    expect(await verifyBallotProof(vk, REAL_PROOF.proof, REAL_PROOF.public_signals)).toBe(true);
    const signals = REAL_PROOF.public_signals.map(BigInt);
    expect(await verifyBallotProof(vk, REAL_PROOF.proof, signals)).toBe(true);
    const other = [...REAL_PROOF.public_signals];
    other[1] = (BigInt(other[1]) + 1n).toString();
    expect(await verifyBallotProof(vk, REAL_PROOF.proof, other)).toBe(false);
    expect(await verifyBallotProof(vk, REAL_PROOF.proof, other.slice(0, 2))).toBe(false);
    expect(await verifyBallotProof(V1_VKEY, REAL_PROOF.proof, REAL_PROOF.public_signals)).toBe(
      false
    );
    const garbage = { ...REAL_PROOF.proof, pi_a: ['x', 'y', '1'] } as Groth16Proof;
    expect(await verifyBallotProof(vk, garbage, REAL_PROOF.public_signals)).toBe(false);
  });
});

describe('loadBallotArtifacts', () => {
  it('loads the three files and checks both verification keys', async () => {
    const { seen, fetchImpl } = server();
    const files = await loadBallotArtifacts(BALLOT_VK_HASH, artifacts(fetchImpl));
    expect(files.ballotVkHash).toBe(BALLOT_VK_HASH);
    expect(files.source).toBe('test');
    expect(files.wasm).toEqual(WASM);
    expect(files.zkey).toEqual(ZKEY);
    expect(files.vkey).toEqual(PINNED_VK);
    expect(seen.sort()).toEqual([ENTRY.vkey.url, ENTRY.wasm.url, ENTRY.zkey.url].sort());
    expect(exportVk).toHaveBeenCalledWith(ZKEY);
  });

  it('refuses a proving key that carries another verification key', async () => {
    exportVk.mockResolvedValue(V1_VKEY);
    const err = (await loadBallotArtifacts(BALLOT_VK_HASH, artifacts(server().fetchImpl)).catch(
      (e: unknown) => e
    )) as ArtifactError;
    expect(err).toBeInstanceOf(ArtifactError);
    expect(err.file).toBe('zkey');
    expect(err.message).toContain(`the registry pins ${BALLOT_VK_HASH}`);

    exportVk.mockRejectedValue(new Error('Invalid File format'));
    await expect(
      loadBallotArtifacts(BALLOT_VK_HASH, artifacts(server().fetchImpl))
    ).rejects.toThrow('zkey: not a proving key: Invalid File format');
  });

  it('refuses a verification key file that is not the registry key', async () => {
    const v1 = toUtf8Bytes(JSON.stringify(V1_VKEY));
    const entry = { ...ENTRY, vkey: { url: 'https://files.example/v1.json', sha256: sha256(v1) } };
    const err = (await loadBallotArtifacts(BALLOT_VK_HASH, {
      table: { [BALLOT_VK_HASH]: entry },
      vkey: { data: v1 },
      fetchImpl: server().fetchImpl,
    }).catch((e: unknown) => e)) as ArtifactError;
    expect(err.file).toBe('vkey');
    expect(err.message).toContain('its verification key hashes to');

    const junk = toUtf8Bytes('not json');
    await expect(
      loadBallotArtifacts(BALLOT_VK_HASH, {
        table: { [BALLOT_VK_HASH]: { ...ENTRY, vkey: { url: 'x', sha256: sha256(junk) } } },
        vkey: { data: junk },
        fetchImpl: server().fetchImpl,
      })
    ).rejects.toThrow('vkey: not JSON');
  });

  it('refuses a key without files', async () => {
    await expect(loadBallotArtifacts(`0x${'77'.repeat(32)}`)).rejects.toThrow(ArtifactError);
  });
});

describe('BallotProver', () => {
  it('proves a built ballot and checks what the proof carries', async () => {
    fullProve.mockResolvedValue(PROVED);
    const ballot = await realProofBallot();
    const { seen, fetchImpl } = server();
    const prover = new BallotProver({ artifacts: artifacts(fetchImpl) });

    const out = await prover.prove(ballot, BALLOT_VK_HASH);
    expect(out.publicSignals).toEqual(REAL_PROOF.public_signals);
    expect(out.proof).toEqual({ ...REAL_PROOF.proof, curve: 'bn128' });
    expect(fullProve).toHaveBeenCalledWith(ballot.circuitInputs, WASM, ZKEY);

    // The files are loaded once per prover and key.
    await prover.prove(ballot, BALLOT_VK_HASH.toUpperCase().replace('0X', '0x'));
    expect(seen).toHaveLength(3);
  });

  it('refuses a proof of other public signals', async () => {
    fullProve.mockResolvedValue(PROVED);
    const other = await realProofBallot({ k: 12345n });
    const prover = new BallotProver({ artifacts: artifacts(server().fetchImpl) });
    const err = (await prover.prove(other, BALLOT_VK_HASH).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BallotProofError);
    expect(err.message).toContain('are not the ballot');
  });

  it('refuses a proof that does not verify, unless verification is off', async () => {
    fullProve.mockResolvedValue({ ...PROVED, proof: SWAPPED });
    const ballot = await realProofBallot();
    const checked = new BallotProver({ artifacts: artifacts(server().fetchImpl) });
    await expect(checked.prove(ballot, BALLOT_VK_HASH)).rejects.toThrow(
      'the ballot proof does not verify'
    );
    const unchecked = new BallotProver({
      artifacts: artifacts(server().fetchImpl),
      verifyProof: false,
    });
    expect((await unchecked.prove(ballot, BALLOT_VK_HASH)).proof).toEqual(SWAPPED);
  });

  it('reports a ballot the circuit refuses', async () => {
    fullProve.mockRejectedValue(new Error('Assert Failed. Error in template CheckBallotMode'));
    const prover = new BallotProver({ artifacts: artifacts(server().fetchImpl) });
    const err = (await prover
      .prove(await realProofBallot(), BALLOT_VK_HASH)
      .catch((e: unknown) => e)) as BallotProofError;
    expect(err).toBeInstanceOf(BallotProofError);
    expect(err.message).toContain('the ballot circuit refused the inputs: Assert Failed');
  });

  it('tries a failed load again on the next call', async () => {
    fullProve.mockResolvedValue(PROVED);
    exportVk.mockRejectedValueOnce(new Error('truncated'));
    const { seen, fetchImpl } = server();
    const prover = new BallotProver({ artifacts: artifacts(fetchImpl) });
    const ballot = await realProofBallot();
    await expect(prover.prove(ballot, BALLOT_VK_HASH)).rejects.toThrow(ArtifactError);
    await prover.prove(ballot, BALLOT_VK_HASH);
    expect(seen).toHaveLength(6);
  });
});
