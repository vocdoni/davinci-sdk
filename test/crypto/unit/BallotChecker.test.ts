type BallotTestCase = {
  name: string;
  fields: number[];
  maxCount: number;
  forceUnique: boolean;
  maxValue: number;
  minValue: number;
  maxTotalCost: number;
  minTotalCost: number;
  costExp: number;
  expectPass: boolean;
};

// padToEight returns a slice of length 8, copying the caller-supplied values
// and zero-filling the remainder (or truncating if more than 8).
function padToEight(vals: number[]): number[] {
  const out = Array(8).fill(0);
  for (let i = 0; i < Math.min(vals.length, 8); i++) {
    out[i] = vals[i];
  }
  return out;
}

// ballotToStrings converts an integer slice to the string slice expected by
// circom inputs.
function ballotToStrings(vals: number[]): string[] {
  return vals.map(v => String(v));
}

type BallotCheckerInputs = {
  fields: string[];
  num_fields: string;
  group_size: string;
  unique_values: string;
  max_value: string;
  min_value: string;
  max_value_sum: string;
  min_value_sum: string;
  cost_exponent: string;
  weight: string;
  cost_from_weight: string;
};

/**
 * Emulates the ballot checker constraints from the Go table test.
 * This is a unit-level behavioral mirror; it does not execute Groth16 proofs.
 */
function emulateBallotChecker(inputs: BallotCheckerInputs): boolean {
  const numFields = Number(inputs.num_fields);
  const uniqueValues = inputs.unique_values === '1';
  const maxValue = Number(inputs.max_value);
  const minValue = Number(inputs.min_value);
  const maxValueSum = Number(inputs.max_value_sum);
  const minValueSum = Number(inputs.min_value_sum);
  const costExponent = Number(inputs.cost_exponent);

  if (!Number.isInteger(numFields) || numFields < 0 || numFields > 8) {
    return false;
  }

  if (!Number.isInteger(costExponent) || costExponent < 1) {
    return false;
  }

  const values = inputs.fields.slice(0, numFields).map(v => Number(v));

  // Range check
  for (const v of values) {
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      return false;
    }
    if (v < minValue || v > maxValue) {
      return false;
    }
  }

  // Uniqueness check
  if (uniqueValues) {
    const set = new Set(values);
    if (set.size !== values.length) {
      return false;
    }
  }

  // Cost check: sum(v_i ^ costExponent)
  let totalCost = 0;
  for (const v of values) {
    totalCost += v ** costExponent;
  }

  if (totalCost < minValueSum) {
    return false;
  }

  // Match Go test semantics: max_total_cost = 0 is treated as "ignored"
  if (maxValueSum > 0 && totalCost > maxValueSum) {
    return false;
  }

  return true;
}

describe('BallotChecker emulation', () => {
  const cases: BallotTestCase[] = [
    {
      name: 'Simple 5-star rating - valid',
      fields: [3, 2, 5],
      maxCount: 3,
      forceUnique: true,
      maxValue: 5,
      minValue: 0,
      maxTotalCost: 15,
      minTotalCost: 0,
      costExp: 1,
      expectPass: true,
    },
    {
      name: 'Duplicate values with uniqueness required - invalid',
      fields: [3, 3, 1],
      maxCount: 3,
      forceUnique: true,
      maxValue: 5,
      minValue: 0,
      maxTotalCost: 16,
      minTotalCost: 0,
      costExp: 1,
      expectPass: false,
    },
    {
      name: 'Maxvalue is correctly verified and maxTotalCost=0 is ignored - valid',
      fields: [50, 49, 48],
      maxCount: 3,
      forceUnique: false,
      maxValue: 50,
      minValue: 0,
      maxTotalCost: 0,
      minTotalCost: 0,
      costExp: 1,
      expectPass: true,
    },
    {
      name: 'Value exceeds maxValue - invalid',
      fields: [13, 0, 0],
      maxCount: 3,
      forceUnique: false,
      maxValue: 12,
      minValue: 0,
      maxTotalCost: 15,
      minTotalCost: 0,
      costExp: 1,
      expectPass: false,
    },
    {
      name: 'Value underflows minValue - invalid',
      fields: [1, 0, 0],
      maxCount: 3,
      forceUnique: false,
      maxValue: 11,
      minValue: 5,
      maxTotalCost: 1000,
      minTotalCost: 0,
      costExp: 1,
      expectPass: false,
    },
    {
      name: 'Quadratic voting cost within limit - valid',
      fields: [2, 2, 2], // cost = 4+4+4 = 12
      maxCount: 3,
      forceUnique: false,
      maxValue: 4,
      minValue: 0,
      maxTotalCost: 12,
      minTotalCost: 0,
      costExp: 2,
      expectPass: true,
    },
    {
      name: 'Quadratic voting cost exceeds limit - invalid',
      fields: [3, 2, 1], // cost = 9+4+1 = 14 > 13
      maxCount: 3,
      forceUnique: false,
      maxValue: 4,
      minValue: 0,
      maxTotalCost: 13,
      minTotalCost: 0,
      costExp: 2,
      expectPass: false,
    },
    {
      name: 'MinTotalCost not reached - invalid',
      fields: [2, 0, 0], // cost = 4 < 5
      maxCount: 3,
      forceUnique: false,
      maxValue: 4,
      minValue: 0,
      maxTotalCost: 20,
      minTotalCost: 5,
      costExp: 2,
      expectPass: false,
    },
    {
      name: 'Duplicates allowed when uniqueness off - valid',
      fields: [5, 5, 0],
      maxCount: 3,
      forceUnique: false,
      maxValue: 5,
      minValue: 0,
      maxTotalCost: 15,
      minTotalCost: 0,
      costExp: 1,
      expectPass: true,
    },
    {
      name: 'Approval voting - exactly 3 of 6 chosen - valid',
      fields: [1, 0, 1, 0, 1, 0],
      maxCount: 6,
      forceUnique: false,
      maxValue: 1,
      minValue: 0,
      maxTotalCost: 3,
      minTotalCost: 3,
      costExp: 1,
      expectPass: true,
    },
    {
      name: 'Approval voting - choose 4 out of 6 (exceeds limit) - invalid',
      fields: [1, 1, 1, 1, 0, 0], // cost 4 > 3
      maxCount: 6,
      forceUnique: false,
      maxValue: 1,
      minValue: 0,
      maxTotalCost: 3,
      minTotalCost: 3,
      costExp: 1,
      expectPass: false,
    },
    {
      name: 'Ranked-choice voting - unique ranks 1..3 - valid',
      fields: [1, 2, 3], // sum = 6
      maxCount: 3,
      forceUnique: true,
      maxValue: 3,
      minValue: 1,
      maxTotalCost: 6,
      minTotalCost: 6,
      costExp: 1,
      expectPass: true,
    },
    {
      name: 'Ranked-choice voting - duplicate rank - invalid',
      fields: [1, 1, 2],
      maxCount: 3,
      forceUnique: true,
      maxValue: 3,
      minValue: 1,
      maxTotalCost: 6,
      minTotalCost: 6,
      costExp: 1,
      expectPass: false,
    },
    {
      name: 'All zeros but minTotalCost positive - invalid',
      fields: [0, 0, 0],
      maxCount: 3,
      forceUnique: false,
      maxValue: 5,
      minValue: 0,
      maxTotalCost: 10,
      minTotalCost: 1,
      costExp: 1,
      expectPass: false,
    },
  ];

  it('should keep helper behavior identical', () => {
    expect(padToEight([1, 2, 3])).toEqual([1, 2, 3, 0, 0, 0, 0, 0]);
    expect(padToEight([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ballotToStrings([10, 0, -2])).toEqual(['10', '0', '-2']);
  });

  for (const tc of cases) {
    it(tc.name, () => {
      const padded = padToEight(tc.fields);
      const uniq = tc.forceUnique ? '1' : '0';

      const inputs: BallotCheckerInputs = {
        fields: ballotToStrings(padded),
        num_fields: String(tc.maxCount),
        group_size: String(tc.maxCount),
        unique_values: uniq,
        max_value: String(tc.maxValue),
        min_value: String(tc.minValue),
        max_value_sum: String(tc.maxTotalCost),
        min_value_sum: String(tc.minTotalCost),
        cost_exponent: String(tc.costExp),
        weight: '0',
        cost_from_weight: '0',
      };

      const passes = emulateBallotChecker(inputs);
      expect(passes).toBe(tc.expectPass);
    });
  }
});
