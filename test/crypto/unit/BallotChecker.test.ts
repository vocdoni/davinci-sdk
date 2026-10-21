import { BallotModeValues, checkBallot } from '../../../src/crypto';

// The CheckBallotMode table of davinci-circom test/ballot_protocol_test.go (a39a9f9), run through
// the 16-field checker. As in that test, groupSize equals numFields and a missing weight is 0.
interface Case {
  name: string;
  fields: number[];
  numFields: number;
  forceUnique: boolean;
  maxValue: number;
  minValue: number;
  maxValueSum: number;
  minValueSum: number;
  costExp: number;
  expectPass: boolean;
  weight?: number;
}

const CIRCOM_CASES: Case[] = [
  {
    name: 'Simple 5-star rating - valid',
    fields: [3, 2, 5],
    numFields: 3,
    forceUnique: true,
    maxValue: 5,
    minValue: 0,
    maxValueSum: 15,
    minValueSum: 0,
    costExp: 1,
    expectPass: true,
  },
  {
    name: 'Duplicate values with uniqueness required - invalid',
    fields: [3, 3, 1],
    numFields: 3,
    forceUnique: true,
    maxValue: 5,
    minValue: 0,
    maxValueSum: 16,
    minValueSum: 0,
    costExp: 1,
    expectPass: false,
  },
  {
    name: 'maxValue is correctly verified and maxValueSum=0 is ignored using weight - valid',
    fields: [50, 49, 48],
    numFields: 3,
    forceUnique: false,
    maxValue: 50,
    minValue: 0,
    maxValueSum: 0,
    minValueSum: 0,
    costExp: 1,
    weight: 50 + 49 + 48,
    expectPass: true,
  },
  {
    name: 'Value exceeds maxValue - invalid',
    fields: [13, 0, 0],
    numFields: 3,
    forceUnique: false,
    maxValue: 12,
    minValue: 0,
    maxValueSum: 15,
    minValueSum: 0,
    costExp: 1,
    expectPass: false,
  },
  {
    name: 'Value underflows minValue - invalid',
    fields: [1, 0, 0],
    numFields: 3,
    forceUnique: false,
    maxValue: 11,
    minValue: 5,
    maxValueSum: 1000,
    minValueSum: 0,
    costExp: 1,
    expectPass: false,
  },
  {
    name: 'Quadratic voting cost within limit - valid',
    fields: [2, 2, 2],
    numFields: 3,
    forceUnique: false,
    maxValue: 4,
    minValue: 0,
    maxValueSum: 12,
    minValueSum: 0,
    costExp: 2,
    expectPass: true,
  },
  {
    name: 'Quadratic voting cost exceeds limit - invalid',
    fields: [3, 2, 1],
    numFields: 3,
    forceUnique: false,
    maxValue: 4,
    minValue: 0,
    maxValueSum: 13,
    minValueSum: 0,
    costExp: 2,
    expectPass: false,
  },
  {
    name: 'minValueSum not reached - invalid',
    fields: [2, 0, 0],
    numFields: 3,
    forceUnique: false,
    maxValue: 4,
    minValue: 0,
    maxValueSum: 20,
    minValueSum: 5,
    costExp: 2,
    expectPass: false,
  },
  {
    name: 'Duplicates allowed when uniqueness off - valid',
    fields: [5, 5, 0],
    numFields: 3,
    forceUnique: false,
    maxValue: 5,
    minValue: 0,
    maxValueSum: 15,
    minValueSum: 0,
    costExp: 1,
    expectPass: true,
  },
  {
    name: 'Approval voting - exactly 3 of 6 chosen - valid',
    fields: [1, 0, 1, 0, 1, 0],
    numFields: 6,
    forceUnique: false,
    maxValue: 1,
    minValue: 0,
    maxValueSum: 3,
    minValueSum: 3,
    costExp: 1,
    expectPass: true,
  },
  {
    name: 'Approval voting - choose 4 out of 6 (exceeds limit) - invalid',
    fields: [1, 1, 1, 1, 0, 0],
    numFields: 6,
    forceUnique: false,
    maxValue: 1,
    minValue: 0,
    maxValueSum: 3,
    minValueSum: 3,
    costExp: 1,
    expectPass: false,
  },
  {
    name: 'Ranked-choice voting - unique ranks 1..3 - valid',
    fields: [1, 2, 3],
    numFields: 3,
    forceUnique: true,
    maxValue: 3,
    minValue: 1,
    maxValueSum: 6,
    minValueSum: 6,
    costExp: 1,
    expectPass: true,
  },
  {
    name: 'Ranked-choice voting - duplicate rank - invalid',
    fields: [1, 1, 2],
    numFields: 3,
    forceUnique: true,
    maxValue: 3,
    minValue: 1,
    maxValueSum: 6,
    minValueSum: 6,
    costExp: 1,
    expectPass: false,
  },
  {
    name: 'All zeros but minValueSum positive - invalid',
    fields: [0, 0, 0],
    numFields: 3,
    forceUnique: false,
    maxValue: 5,
    minValue: 0,
    maxValueSum: 10,
    minValueSum: 1,
    costExp: 1,
    expectPass: false,
  },
  {
    name: 'Exceed assigned weight - invalid',
    fields: [25, 0, 0, 0],
    numFields: 4,
    forceUnique: false,
    maxValue: 50,
    minValue: 0,
    maxValueSum: 0,
    minValueSum: 0,
    costExp: 1,
    expectPass: false,
    weight: 10,
  },
  {
    name: 'Less value than assigned weight - valid',
    fields: [25, 0, 0, 0],
    numFields: 4,
    forceUnique: false,
    maxValue: 50,
    minValue: 0,
    maxValueSum: 0,
    minValueSum: 0,
    costExp: 1,
    expectPass: true,
    weight: 50,
  },
  {
    name: 'Exceed assigned weight but without max value sum - invalid',
    fields: [75, 0, 0, 0],
    numFields: 4,
    forceUnique: false,
    maxValue: 75,
    minValue: 0,
    maxValueSum: 0,
    minValueSum: 0,
    costExp: 1,
    expectPass: false,
    weight: 50,
  },
];

const modeOf = (c: Case): BallotModeValues => ({
  numFields: c.numFields,
  groupSize: c.numFields,
  uniqueValues: c.forceUnique,
  costExponent: c.costExp,
  maxValue: BigInt(c.maxValue),
  minValue: BigInt(c.minValue),
  maxValueSum: BigInt(c.maxValueSum),
  minValueSum: BigInt(c.minValueSum),
});

describe('ballot checker', () => {
  for (const c of CIRCOM_CASES) {
    it(c.name, () => {
      const r = checkBallot(c.fields, modeOf(c), BigInt(c.weight ?? 0));
      expect(r.valid, r.error).toBe(c.expectPass);
      if (!c.expectPass) expect(r.error).toBeTruthy();
    });
  }

  const approval16: BallotModeValues = {
    numFields: 16,
    groupSize: 1,
    uniqueValues: false,
    costExponent: 1,
    maxValue: 1n,
    minValue: 0n,
    maxValueSum: 16n,
    minValueSum: 0n,
  };

  it('uses all 16 fields', () => {
    expect(checkBallot(Array<number>(16).fill(1), approval16, 1n).valid).toBe(true);
    const r = checkBallot([...Array<number>(15).fill(1), 2], approval16, 1n);
    expect(r).toEqual({ valid: false, error: 'field 15 is above maxValue 1' });
  });

  it('refuses more values than fields and values of 48 bits or more', () => {
    const m = { ...approval16, numFields: 2, maxValue: (1n << 48n) - 1n, maxValueSum: 0n };
    expect(checkBallot([1, 1, 0], m, 10n).error).toBe('3 values for 2 fields');
    expect(checkBallot([1n << 48n], m, 1n << 60n).error).toBe('field 0 is not below 2^48');
    expect(checkBallot([-1], m, 10n).error).toBe('field 0 is not below 2^48');
    expect(checkBallot([(1n << 48n) - 1n], m, 1n << 48n).valid).toBe(true);
    expect(checkBallot([], { ...m, numFields: 17, groupSize: 1 }, 1n).error).toBe(
      'numFields 17 exceeds 16'
    );
    expect(checkBallot([], { ...m, groupSize: 3 }, 1n).error).toMatch('groupSize');
  });

  it('only checks bounds and uniqueness on active fields', () => {
    const m: BallotModeValues = {
      numFields: 3,
      groupSize: 3,
      uniqueValues: true,
      costExponent: 1,
      maxValue: 5n,
      minValue: 1n,
      maxValueSum: 0n,
      minValueSum: 0n,
    };
    // The 13 inactive fields are 0, below minValue and equal to each other.
    expect(checkBallot([1, 2, 3], m, 6n).valid).toBe(true);
    expect(checkBallot([1, 2, 3], m, 5n).error).toBe('total cost 6 exceeds the weight 5');
  });

  it('counts each active field once with a zero cost exponent', () => {
    const m = { ...approval16, numFields: 4, costExponent: 0, maxValue: 9n, maxValueSum: 4n };
    expect(checkBallot([0, 7, 9], m, 0n).valid).toBe(true);
    expect(checkBallot([], { ...m, minValueSum: 5n }, 0n).error).toBe(
      'total cost 4 is below minValueSum 5'
    );
  });

  it('compares the integer cost, which the registry keeps below 2^63', () => {
    // (2^47)^8 is past p: the registry refuses the mode (numFields * maxValue^costExponent
    // >= 2^63), and the checker compares the integer, never a reduced sum.
    const v = 1n << 47n;
    const m = {
      ...approval16,
      numFields: 1,
      costExponent: 8,
      maxValue: v,
      maxValueSum: (1n << 63n) - 1n,
    };
    expect(checkBallot([v], m, 0n)).toEqual({
      valid: false,
      error: `total cost ${v ** 8n} exceeds maxValueSum ${m.maxValueSum}`,
    });
    // The largest cost a mode the registry takes can reach: 16 * (2^48 - 1).
    const top = (1n << 48n) - 1n;
    const wide = { ...approval16, maxValue: top, maxValueSum: 16n * top };
    expect(checkBallot(Array<bigint>(16).fill(top), wide, 0n).valid).toBe(true);
  });

  it('compares the cost with any census weight when the weight is the budget', () => {
    // a5's process PB: 4 fields of 0..10, cost exponent 8, maxValueSum 0.
    const m = {
      ...approval16,
      numFields: 4,
      groupSize: 4,
      maxValue: 10n,
      costExponent: 8,
      maxValueSum: 0n,
    };
    // The 89-bit comparator is exact for every weight below 2^88.
    expect(checkBallot([0, 0, 0, 0], m, 1n << 63n).valid).toBe(true);
    expect(checkBallot([10, 0, 0, 0], m, 1n << 63n).valid).toBe(true);
    expect(checkBallot([10, 10, 10, 10], m, (1n << 88n) - 1n).valid).toBe(true);
    expect(checkBallot([1], m, 1n << 64n).valid).toBe(true);
    expect(checkBallot([2, 0, 0, 0], m, 255n).error).toBe('total cost 256 exceeds the weight 255');
    // A census weight is below 2^88.
    expect(checkBallot([0, 0, 0, 0], m, 1n << 88n).error).toBe('weight does not fit in 88 bits');
  });
});
