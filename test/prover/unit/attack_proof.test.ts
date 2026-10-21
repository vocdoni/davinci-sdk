import { BN254_FR } from '../../../src/crypto';
import { verifyBallotProof } from '../../../src/prover';
import { NO_PHASE2_VKEY, OTHER_VKEY, REAL_PROOF } from '../../helpers/realProof';

const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const signals = REAL_PROOF.public_signals;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// BUG: snarkjs reduces proof coordinates mod q, so verifyBallotProof accepts a spelling the node refuses.
describe('attack: verifying a ballot proof', () => {
  it('accepts the real proof', async () => {
    expect(await verifyBallotProof(REAL_PROOF.vk, REAL_PROOF.proof, signals)).toBe(true);
  });

  it('refuses a public signal plus the field modulus (a second spelling of the same input)', async () => {
    for (const i of [0, 1, 2, 3, 6, 7, 70]) {
      const s = [...signals];
      s[i] = (BigInt(s[i]) + BN254_FR).toString();
      expect(await verifyBallotProof(REAL_PROOF.vk, REAL_PROOF.proof, s)).toBe(false);
    }
    const neg = [...signals];
    neg[0] = '-1';
    expect(await verifyBallotProof(REAL_PROOF.vk, REAL_PROOF.proof, neg)).toBe(false);
  });

  it('refuses a changed signal, wrong lengths, hex or junk', async () => {
    const s = [...signals];
    s[5] = (BigInt(s[5]) + 1n).toString();
    expect(await verifyBallotProof(REAL_PROOF.vk, REAL_PROOF.proof, s)).toBe(false);
    expect(await verifyBallotProof(REAL_PROOF.vk, REAL_PROOF.proof, signals.slice(1))).toBe(false);
    expect(await verifyBallotProof(REAL_PROOF.vk, REAL_PROOF.proof, [...signals, '0'])).toBe(false);
    for (const junk of ['abc', '', ' 1', '1.5', 'NaN']) {
      const j = [...signals];
      j[2] = junk;
      expect(await verifyBallotProof(REAL_PROOF.vk, REAL_PROOF.proof, j)).toBe(false);
    }
  });

  it('refuses malformed, off-curve, identity and non-canonical proof points', async () => {
    const mut = async (f: (p: typeof REAL_PROOF.proof) => void) => {
      const p = clone(REAL_PROOF.proof);
      f(p);
      return verifyBallotProof(REAL_PROOF.vk, p, signals);
    };
    expect(await mut(p => (p.pi_a[0] = '5'))).toBe(false);
    expect(await mut(p => (p.pi_a[0] = (BigInt(p.pi_a[0]) + Q).toString()))).toBe(false);
    expect(await mut(p => (p.pi_a = ['0', '1', '0']))).toBe(false);
    expect(await mut(p => (p.pi_c = ['0', '1', '0']))).toBe(false);
    expect(
      await mut(
        p =>
          (p.pi_b = [
            ['0', '0'],
            ['1', '0'],
            ['0', '0'],
          ])
      )
    ).toBe(false);
    expect(await mut(p => (p.pi_b[0][0] = '5'))).toBe(false);
    expect(await mut(p => (p.pi_a = [p.pi_a[0], p.pi_a[1]] as never))).toBe(false);
    expect(await mut(p => (p.protocol = 'plonk'))).toBe(false);
    // the negated pi_c is a valid point but a different proof
    expect(await mut(p => (p.pi_c[1] = (Q - BigInt(p.pi_c[1])).toString()))).toBe(false);
  });

  it('refuses a key without phase 2 or another key', async () => {
    expect(await verifyBallotProof(NO_PHASE2_VKEY, REAL_PROOF.proof, signals)).toBe(false);
    expect(await verifyBallotProof(OTHER_VKEY, REAL_PROOF.proof, signals)).toBe(false);
  });
});
