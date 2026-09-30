import { getBytes, keccak256, concat } from 'ethers';
import {
  BJJ_B8,
  BJJ_SUBGROUP_ORDER,
  BN254_FR,
  ORGANIZER_REGISTER_DOMAIN,
  bjjAdd,
  bjjMul,
  bjjMulBase,
  pointFromReducedTE,
  pointToReducedTE,
  proveOrganizerKey,
  randomOrganizerSecret,
} from '../../../src/crypto';
import { bigIntToBytes } from '../../../src/crypto/field';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/dkg_schnorr.json (davinci-dkg).
interface DkgVectors {
  subgroupOrderL: string;
  organizer: {
    label: string;
    epochId: string;
    aid: string;
    secret: string;
    witness: string;
    pkOrgX: string;
    pkOrgY: string;
    ax: string;
    ay: string;
    z: string;
  }[];
}

// Reduced-form generator G = toRTE(B8) and the reduced curve's d (davinci-zkvm tests/dkg.rs).
const G_X = 9671717474070082183213120605117400219616337014328744928644933853176787189663n;
const G_Y = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;
const D_RTE = 12181644023421730124874158521699555681764249180949974110617291017600649128846n;

// The vectors write short aids; they are right-aligned 32-byte values.
const aid32 = (hex: string) => `0x${hex.slice(2).padStart(64, '0')}`;

describe('DKG point map', () => {
  it('maps B8 to the reduced-form generator and back', () => {
    expect(pointToReducedTE(BJJ_B8)).toEqual({ x: G_X, y: G_Y });
    expect(pointFromReducedTE(G_X, G_Y)).toEqual(BJJ_B8);
  });

  it('lands on the reduced curve -x^2 + y^2 = 1 + d x^2 y^2', () => {
    for (const k of [1n, 2n, 12345n, BJJ_SUBGROUP_ORDER - 1n]) {
      const { x, y } = pointToReducedTE(bjjMulBase(k));
      const x2 = (x * x) % BN254_FR;
      const y2 = (y * y) % BN254_FR;
      expect((BN254_FR - x2 + y2) % BN254_FR).toBe(
        (1n + ((D_RTE * x2) % BN254_FR) * y2) % BN254_FR
      );
      expect(pointFromReducedTE(x, y)).toEqual(bjjMulBase(k));
    }
  });

  it('refuses non-canonical coordinates', () => {
    expect(() => pointFromReducedTE(BN254_FR, 0n)).toThrow('below p');
    expect(() => pointFromReducedTE(0n, BN254_FR)).toThrow('below p');
  });
});

describe('organizer proof of possession', () => {
  const v = loadFixture<DkgVectors>('zkvm/dkg_schnorr.json');

  it('uses the raw keccak of the organizer domain', () => {
    expect(ORGANIZER_REGISTER_DOMAIN).toBe(
      '0x41ea6f3fa95eccd1f3b1ce8e05efa11027280aa0c6b4167fd6695db659c30b28'
    );
    expect(BigInt(v.subgroupOrderL)).toBe(BJJ_SUBGROUP_ORDER);
  });

  it('matches the davinci-dkg vectors', () => {
    expect(v.organizer).toHaveLength(3);
    for (const c of v.organizer) {
      const proof = proveOrganizerKey({
        epochId: c.epochId,
        aid: aid32(c.aid),
        secret: BigInt(c.secret),
        witness: BigInt(c.witness),
      });
      expect(proof, c.label).toEqual({
        pkX: BigInt(c.pkOrgX),
        pkY: BigInt(c.pkOrgY),
        aX: BigInt(c.ax),
        aY: BigInt(c.ay),
        z: BigInt(c.z),
      });
      // The aid may also be given as its integer.
      expect(
        proveOrganizerKey({
          epochId: c.epochId,
          aid: BigInt(aid32(c.aid)),
          secret: BigInt(c.secret),
          witness: BigInt(c.witness),
        })
      ).toEqual(proof);
    }
  });

  it('verifies: z*B8 == A + c*PK in TE form', () => {
    const secret = randomOrganizerSecret();
    const epochId = `0x${'00'.repeat(11)}77`;
    const aid = `0x${'ab'.repeat(32)}`;
    const p = proveOrganizerKey({ epochId, aid, secret });
    const pk = pointFromReducedTE(p.pkX, p.pkY);
    const a = pointFromReducedTE(p.aX, p.aY);
    expect(pk).toEqual(bjjMulBase(secret));
    const c =
      BigInt(
        keccak256(
          concat([
            getBytes(ORGANIZER_REGISTER_DOMAIN),
            getBytes(epochId),
            getBytes(aid),
            ...[p.pkX, p.pkY, p.aX, p.aY].map(x => bigIntToBytes(x)),
          ])
        )
      ) % BJJ_SUBGROUP_ORDER;
    expect(bjjMulBase(p.z)).toEqual(bjjAdd(a, bjjMul(pk, c)));
    expect(p.z < BJJ_SUBGROUP_ORDER).toBe(true);
  });

  it('refuses scalars outside [1, L) and malformed ids', () => {
    const base = { epochId: `0x${'00'.repeat(12)}`, aid: 1n, secret: 5n, witness: 7n };
    expect(() => proveOrganizerKey({ ...base, secret: 0n })).toThrow('[1, L)');
    expect(() => proveOrganizerKey({ ...base, secret: BJJ_SUBGROUP_ORDER })).toThrow('[1, L)');
    expect(() => proveOrganizerKey({ ...base, witness: 0n })).toThrow('[1, L)');
    expect(() => proveOrganizerKey({ ...base, epochId: '0x1234' })).toThrow('12 bytes');
    expect(() => proveOrganizerKey({ ...base, aid: '0x1234' })).toThrow('32 bytes');
    expect(() => proveOrganizerKey({ ...base, aid: 1n << 256n })).toThrow('32 bytes');
  });

  it('draws organizer secrets in [1, L)', () => {
    for (let i = 0; i < 50; i++) {
      const s = randomOrganizerSecret();
      expect(s > 0n && s < BJJ_SUBGROUP_ORDER).toBe(true);
    }
  });
});
