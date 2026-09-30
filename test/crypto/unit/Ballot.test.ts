import {
  BN254_FR,
  Ballot,
  BallotModeValues,
  BjjPoint,
  IDENTITY_CIPHERTEXT,
  addressToField,
  ballotCoords,
  ballotInputsHashPreimage,
  bjjMulBase,
  buildBallot,
  computeBallotInputsHash,
  computeVoteId,
  encryptBallot,
  isBallotPaddingValid,
  multiPoseidon,
  packBallotMode,
  processIdToField,
  unpackBallotMode,
} from '../../../src/crypto';
import { bigIntToHex } from '../../../src/crypto/field';
import { loadFixture } from '../../helpers/fixtures';

// Vectors: davinci-zkvm rust-sdk/testdata/{ballot_mode,elgamal,ballots,real_proof}.json.
type Int = string | number;
interface ModeJson {
  num_fields: number;
  group_size: number;
  unique_values: boolean;
  cost_exponent: number;
  max_value: Int;
  min_value: Int;
  max_value_sum: Int;
  min_value_sum: Int;
  packed: string;
}
interface Dec {
  x: string;
  y: string;
}
interface BallotJson {
  process_id: string;
  address: string;
  k: string;
  weight: string;
  mode: ModeJson;
  fields: Int[];
  pk: Dec;
  vote_id: Int;
  ballot: string[];
  inputs_hash: string;
  inputs: string[];
}
interface ElGamalBallots {
  pk: Dec;
  ballots: { nf: number; k: string; fields: Int[]; ballot: string[] }[];
}
interface RealProof {
  public_signals: string[];
  ballot: BallotJson;
}

const mode = (m: ModeJson): BallotModeValues => ({
  numFields: m.num_fields,
  groupSize: m.group_size,
  uniqueValues: m.unique_values,
  costExponent: m.cost_exponent,
  maxValue: BigInt(m.max_value),
  minValue: BigInt(m.min_value),
  maxValueSum: BigInt(m.max_value_sum),
  minValueSum: BigInt(m.min_value_sum),
});
const pt = (d: Dec): BjjPoint => ({ x: BigInt(d.x), y: BigInt(d.y) });
const coords = (b: Ballot) => ballotCoords(b).map(String);

describe('ballot mode packing', () => {
  const modes = loadFixture<ModeJson[]>('zkvm/ballot_mode.json');

  it('packs and unpacks like the Go reference', () => {
    expect(modes.length).toBeGreaterThan(0);
    for (const m of modes) {
      expect(packBallotMode(mode(m))).toBe(BigInt(m.packed));
      expect(unpackBallotMode(BigInt(m.packed))).toEqual(mode(m));
    }
  });

  it('refuses values that would overlap other fields', () => {
    const base = mode(modes[2]);
    expect(() => packBallotMode({ ...base, groupSize: base.numFields + 1 })).toThrow('groupSize');
    expect(() => packBallotMode({ ...base, maxValue: 1n << 48n })).toThrow('48 bits');
    expect(() => packBallotMode({ ...base, minValue: 1n << 48n })).toThrow('48 bits');
    expect(() => packBallotMode({ ...base, maxValueSum: 1n << 63n })).toThrow('63 bits');
    expect(() => packBallotMode({ ...base, minValueSum: 1n << 63n })).toThrow('63 bits');
    expect(() => packBallotMode({ ...base, minValue: -1n })).toThrow('48 bits');
    expect(() => packBallotMode({ ...base, costExponent: 256 })).toThrow('u8');
    expect(() => packBallotMode({ ...base, numFields: 1.5 })).toThrow('u8');
  });

  it('refuses bits above 247 and a group size above the field count', () => {
    const packed = packBallotMode(mode(modes[2]));
    expect(() => unpackBallotMode(packed | (1n << 248n))).toThrow('247');
    expect(() => unpackBallotMode(packed | (1n << 247n))).toThrow('247');
    expect(() => unpackBallotMode(-1n)).toThrow('247');
    expect(() => unpackBallotMode(1n | (2n << 8n))).toThrow('groupSize');
    // Values at the top of their widths round-trip.
    const top: BallotModeValues = {
      numFields: 255,
      groupSize: 255,
      uniqueValues: true,
      costExponent: 255,
      maxValue: (1n << 48n) - 1n,
      minValue: (1n << 48n) - 1n,
      maxValueSum: (1n << 63n) - 1n,
      minValueSum: (1n << 63n) - 1n,
    };
    expect(packBallotMode(top)).toBe((1n << 247n) - 1n);
    expect(unpackBallotMode((1n << 247n) - 1n)).toEqual(top);
  });
});

describe('ballot encryption', () => {
  const v = loadFixture<ElGamalBallots>('zkvm/elgamal.json');

  it('encrypts 16 fields with identity padding like the Go reference', async () => {
    const pk = pt(v.pk);
    for (const b of v.ballots) {
      const got = await encryptBallot(pk, b.fields.map(BigInt), BigInt(b.k), b.nf);
      expect(got).toHaveLength(16);
      expect(coords(got), `nf = ${b.nf}`).toEqual(b.ballot);
      expect(isBallotPaddingValid(got, b.nf)).toBe(true);
      if (b.nf < 16) {
        expect(got[b.nf]).toEqual(IDENTITY_CIPHERTEXT);
        expect(isBallotPaddingValid(got, b.nf - 1)).toBe(false);
      }
    }
  });

  it('reads missing values as zero and refuses more than 16', async () => {
    const pk = pt(v.pk);
    const b = v.ballots[1];
    const padded = [...b.fields.map(BigInt), 0n, 0n];
    expect(coords(await encryptBallot(pk, padded.slice(0, b.nf), BigInt(b.k), b.nf))).toEqual(
      b.ballot
    );
    await expect(encryptBallot(pk, Array<bigint>(17).fill(0n), 1n, 16)).rejects.toThrow('16');
    await expect(encryptBallot(pk, [-1n], 1n, 1)).rejects.toThrow('u64');
  });
});

describe('ballot encryption guards', () => {
  const v = loadFixture<ElGamalBallots>('zkvm/elgamal.json');
  const pk = pt(v.pk);

  it('refuses more values than numFields instead of dropping them', async () => {
    await expect(encryptBallot(pk, [1n, 2n, 3n], 7n, 2)).rejects.toThrow('3 values for 2 fields');
    expect(await encryptBallot(pk, [1n, 2n], 7n, 2)).toHaveLength(16);
  });

  it('refuses a numFields that is not an integer in 1..16', async () => {
    for (const nf of [2.5, 0, 17, -1, Number.NaN]) {
      await expect(encryptBallot(pk, [], 7n, nf), `nf = ${nf}`).rejects.toThrow('numFields');
    }
  });

  it('checks padding only on a full 16-ciphertext ballot', async () => {
    const b = await encryptBallot(pk, [1n, 2n, 3n], 7n, 3);
    expect(isBallotPaddingValid(b, 3)).toBe(true);
    expect(isBallotPaddingValid([], 16)).toBe(false);
    expect(isBallotPaddingValid(b.slice(0, 3), 3)).toBe(false);
    expect(isBallotPaddingValid([...b, IDENTITY_CIPHERTEXT], 3)).toBe(false);
  });
});

describe('vote id, inputs hash and circuit inputs', () => {
  const ballots = loadFixture<BallotJson[]>('zkvm/ballots.json');

  it('match the Go reference for 16-field ballots', async () => {
    expect(ballots.length).toBeGreaterThan(0);
    for (const b of ballots) {
      const processId = BigInt(b.process_id);
      const address = addressToField(b.address);
      const k = BigInt(b.k);
      const voteId = await computeVoteId(processId, address, k);
      expect(voteId).toBe(BigInt(b.vote_id));
      const m = mode(b.mode);
      const pk = pt(b.pk);
      const ballot = await encryptBallot(pk, b.fields.map(BigInt), k, m.numFields);
      expect(coords(ballot)).toEqual(b.ballot);
      const params = {
        processId,
        ballotMode: m,
        encryptionKey: pk,
        address,
        voteId,
        ballot,
        weight: BigInt(b.weight),
      };
      expect(ballotInputsHashPreimage(params).map(String)).toEqual(b.inputs);
      expect(b.inputs).toHaveLength(71);
      expect(await computeBallotInputsHash(params)).toBe(BigInt(b.inputs_hash));
      expect(await multiPoseidon(b.inputs.map(BigInt))).toBe(BigInt(b.inputs_hash));
    }
  });

  it('buildBallot assembles the same values and the circuit inputs', async () => {
    for (const b of ballots) {
      const built = await buildBallot({
        processId: bigIntToHex(BigInt(b.process_id), 31),
        address: `0x${b.address}`,
        encryptionKey: pt(b.pk),
        ballotMode: mode(b.mode),
        fields: b.fields.map(BigInt),
        weight: BigInt(b.weight),
        k: BigInt(b.k),
      });
      const address = addressToField(b.address);
      expect(built.voteId).toBe(BigInt(b.vote_id));
      expect(coords(built.ballot)).toEqual(b.ballot);
      expect(built.inputsHash).toBe(BigInt(b.inputs_hash));
      expect(built.publicSignals).toEqual([address, BigInt(b.vote_id), BigInt(b.inputs_hash)]);
      const ci = built.circuitInputs;
      expect(ci.fields).toHaveLength(16);
      expect(ci.fields.slice(0, b.fields.length)).toEqual(b.fields.map(String));
      expect(ci.fields.slice(b.fields.length).every(f => f === '0')).toBe(true);
      expect(ci.packed_ballot_mode).toBe(b.mode.packed);
      expect(ci.address).toBe(address.toString());
      expect(ci.process_id).toBe(b.process_id);
      expect(ci.vote_id).toBe(String(b.vote_id));
      expect(ci.weight).toBe(b.weight);
      expect(ci.k).toBe(b.k);
      expect(ci.encryption_pubkey).toEqual([b.pk.x, b.pk.y]);
      expect(ci.cipherfields.flat(2)).toEqual(b.ballot);
      expect(ci.inputs_hash).toBe(b.inputs_hash);
    }
  });

  it('produces the public signals of a real proof under the pinned VK', async () => {
    const { public_signals: pubs, ballot: b } = loadFixture<RealProof>('zkvm/real_proof.json');
    const built = await buildBallot({
      processId: bigIntToHex(BigInt(b.process_id), 31),
      address: `0x${b.address}`,
      encryptionKey: pt(b.pk),
      ballotMode: mode(b.mode),
      fields: b.fields.map(BigInt),
      weight: BigInt(b.weight),
      k: BigInt(b.k),
    });
    expect(built.publicSignals.map(String)).toEqual(pubs);
    expect(coords(built.ballot)).toEqual(b.ballot);
  });

  it('buildBallot refuses bad keys, field counts and weights', async () => {
    const b = ballots[0];
    const base = {
      processId: bigIntToHex(BigInt(b.process_id), 31),
      address: `0x${b.address}`,
      encryptionKey: pt(b.pk),
      ballotMode: mode(b.mode),
      fields: b.fields.map(BigInt),
      weight: 1n,
      k: 7n,
    };
    await expect(buildBallot({ ...base, encryptionKey: { x: 0n, y: 1n } })).rejects.toThrow(
      'subgroup'
    );
    const order2 = { x: 0n, y: BN254_FR - 1n };
    await expect(buildBallot({ ...base, encryptionKey: order2 })).rejects.toThrow('subgroup');
    await expect(
      buildBallot({ ...base, fields: Array<bigint>(base.ballotMode.numFields + 1).fill(0n) })
    ).rejects.toThrow('values for');
    await expect(
      buildBallot({ ...base, ballotMode: { ...base.ballotMode, numFields: 0, groupSize: 0 } })
    ).rejects.toThrow('numFields');
    await expect(
      buildBallot({ ...base, ballotMode: { ...base.ballotMode, numFields: 17 } })
    ).rejects.toThrow('numFields');
    await expect(buildBallot({ ...base, weight: 1n << 88n })).rejects.toThrow('88 bits');
    await expect(buildBallot({ ...base, processId: '0x1234' })).rejects.toThrow('31 bytes');
    await expect(buildBallot({ ...base, k: -1n })).rejects.toThrow('below p');
    expect(isBallotPaddingValid(await encryptBallot(bjjMulBase(5n), [1n], 3n, 1), 1)).toBe(true);
  });
});

describe('field encodings', () => {
  it('reads addresses and process ids big-endian', () => {
    expect(addressToField('0x0000000000000000000000000000000000000102')).toBe(0x102n);
    expect(addressToField('0xABCDEF0000000000000000000000000000000001')).toBe(
      0xabcdef0000000000000000000000000000000001n
    );
    expect(processIdToField(`0x${'00'.repeat(30)}ff`)).toBe(255n);
    expect(() => addressToField('0x1234')).toThrow('20 bytes');
    expect(() => processIdToField(`0x${'00'.repeat(32)}`)).toThrow('31 bytes');
  });
});
