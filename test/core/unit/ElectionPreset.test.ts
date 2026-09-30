import { describe, expect, it } from 'vitest';
import {
  BallotModeError,
  ElectionPreset,
  ballotModeValues,
  parseElectionPresetFromMetadata,
  resolveElectionPreset,
} from '../../../src/core/types/ballot';
import { checkBallot } from '../../../src/crypto';

function questionsWith(choices: number) {
  return [
    {
      choices: Array.from({ length: choices }, (_, i) => ({
        title: `c${i}`,
        value: i,
      })),
    },
  ];
}

describe('resolveElectionPreset', () => {
  describe('single_choice', () => {
    it('requires exactly one selection by default', () => {
      const ballot = resolveElectionPreset({ type: 'single_choice' }, questionsWith(5));
      expect(ballot).toEqual({
        numFields: 5,
        groupSize: 5,
        minValue: '0',
        maxValue: '1',
        uniqueValues: false,
        costExponent: 1,
        minValueSum: '1',
        maxValueSum: '1',
      });
    });

    it('allows zero selections when allowAbstain is true', () => {
      const ballot = resolveElectionPreset(
        { type: 'single_choice', allowAbstain: true },
        questionsWith(3)
      );
      expect(ballot.minValueSum).toBe('0');
      expect(ballot.maxValueSum).toBe('1');
    });
  });

  describe('multiple_choice', () => {
    it('uses minSelections=0 by default', () => {
      const ballot = resolveElectionPreset(
        { type: 'multiple_choice', maxSelections: 3 },
        questionsWith(5)
      );
      expect(ballot).toEqual({
        numFields: 5,
        groupSize: 5,
        minValue: '0',
        maxValue: '1',
        uniqueValues: false,
        costExponent: 1,
        minValueSum: '0',
        maxValueSum: '3',
      });
    });

    it('accepts explicit minSelections', () => {
      const ballot = resolveElectionPreset(
        { type: 'multiple_choice', minSelections: 2, maxSelections: 4 },
        questionsWith(5)
      );
      expect(ballot.minValueSum).toBe('2');
      expect(ballot.maxValueSum).toBe('4');
    });

    it('rejects maxSelections > numFields', () => {
      expect(() =>
        resolveElectionPreset({ type: 'multiple_choice', maxSelections: 7 }, questionsWith(5))
      ).toThrow(/maxSelections \(7\) cannot exceed numFields \(5\)/);
    });

    it('rejects minSelections > maxSelections', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'multiple_choice', minSelections: 4, maxSelections: 2 },
          questionsWith(5)
        )
      ).toThrow(/minSelections \(4\) cannot exceed maxSelections \(2\)/);
    });

    it('rejects maxSelections < 1', () => {
      expect(() =>
        resolveElectionPreset({ type: 'multiple_choice', maxSelections: 0 }, questionsWith(5))
      ).toThrow(/maxSelections must be >= 1/);
    });

    it('rejects negative minSelections', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'multiple_choice', minSelections: -1, maxSelections: 2 },
          questionsWith(5)
        )
      ).toThrow(/minSelections \(-1\) cannot be negative/);
    });
  });

  describe('approval', () => {
    it('caps maxValueSum at numFields', () => {
      const ballot = resolveElectionPreset({ type: 'approval' }, questionsWith(4));
      expect(ballot).toEqual({
        numFields: 4,
        groupSize: 4,
        minValue: '0',
        maxValue: '1',
        uniqueValues: false,
        costExponent: 1,
        minValueSum: '0',
        maxValueSum: '4',
      });
    });
  });

  describe('rating', () => {
    it('uses minValue=0 by default and scales sums by numFields', () => {
      const ballot = resolveElectionPreset({ type: 'rating', maxValue: 5 }, questionsWith(3));
      expect(ballot).toEqual({
        numFields: 3,
        groupSize: 3,
        minValue: '0',
        maxValue: '5',
        uniqueValues: false,
        costExponent: 1,
        minValueSum: '0',
        maxValueSum: '15',
      });
    });

    it('respects explicit minValue', () => {
      const ballot = resolveElectionPreset(
        { type: 'rating', minValue: 1, maxValue: 10 },
        questionsWith(2)
      );
      expect(ballot.minValue).toBe('1');
      expect(ballot.maxValue).toBe('10');
      expect(ballot.minValueSum).toBe('2');
      expect(ballot.maxValueSum).toBe('20');
    });

    it('rejects maxValue <= minValue', () => {
      expect(() =>
        resolveElectionPreset({ type: 'rating', minValue: 5, maxValue: 5 }, questionsWith(2))
      ).toThrow(/maxValue \(5\) must be greater than minValue \(5\)/);
    });
  });

  describe('ranking', () => {
    it('sets exact permutation sum for n=3', () => {
      const ballot = resolveElectionPreset({ type: 'ranking' }, questionsWith(3));
      expect(ballot).toEqual({
        numFields: 3,
        groupSize: 3,
        minValue: '1',
        maxValue: '3',
        uniqueValues: true,
        costExponent: 1,
        minValueSum: '6',
        maxValueSum: '6',
      });
    });

    it('sets exact permutation sum for n=5', () => {
      const ballot = resolveElectionPreset({ type: 'ranking' }, questionsWith(5));
      expect(ballot.minValueSum).toBe('15');
      expect(ballot.maxValueSum).toBe('15');
      expect(ballot.maxValue).toBe('5');
    });

    it('sets exact permutation sum for n=10', () => {
      const ballot = resolveElectionPreset({ type: 'ranking' }, questionsWith(10));
      expect(ballot.minValueSum).toBe('55');
      expect(ballot.maxValueSum).toBe('55');
    });
  });

  describe('quadratic', () => {
    it('uses minValueSum=0 by default', () => {
      const ballot = resolveElectionPreset({ type: 'quadratic', budget: 100 }, questionsWith(4));
      expect(ballot).toEqual({
        numFields: 4,
        groupSize: 4,
        minValue: '0',
        maxValue: '100',
        uniqueValues: false,
        costExponent: 2,
        minValueSum: '0',
        maxValueSum: '100',
      });
    });

    it('respects explicit minValueSum', () => {
      const ballot = resolveElectionPreset(
        { type: 'quadratic', budget: 50, minValueSum: 10 },
        questionsWith(3)
      );
      expect(ballot.minValueSum).toBe('10');
    });

    it('rejects budget <= 0', () => {
      expect(() =>
        resolveElectionPreset({ type: 'quadratic', budget: 0 }, questionsWith(3))
      ).toThrow(/budget \(0\) must be > 0/);
    });

    it('rejects negative minValueSum', () => {
      expect(() =>
        resolveElectionPreset({ type: 'quadratic', budget: 50, minValueSum: -1 }, questionsWith(3))
      ).toThrow(/minValueSum \(-1\) must be >= 0/);
    });
  });

  describe('cross-cutting validation', () => {
    it('rejects empty questions array', () => {
      expect(() => resolveElectionPreset({ type: 'approval' }, [])).toThrow(
        /requires at least one question/
      );
    });

    it('rejects questions[0] with no choices', () => {
      expect(() => resolveElectionPreset({ type: 'approval' }, [{ choices: [] }])).toThrow(
        /questions\[0\]\.choices to be non-empty/
      );
    });
  });
});

describe('parseElectionPresetFromMetadata', () => {
  describe('happy path — recovers each preset shape', () => {
    const cases: Array<[string, ElectionPreset]> = [
      ['single_choice', { type: 'single_choice' }],
      ['single_choice w/ abstain', { type: 'single_choice', allowAbstain: true }],
      ['multiple_choice', { type: 'multiple_choice', maxSelections: 3 }],
      ['approval', { type: 'approval' }],
      ['rating', { type: 'rating', maxValue: 5 }],
      ['ranking', { type: 'ranking' }],
      ['quadratic', { type: 'quadratic', budget: 100 }],
    ];

    for (const [label, preset] of cases) {
      it(`returns ${label}`, () => {
        expect(parseElectionPresetFromMetadata({ meta: { electionPreset: preset } })).toEqual(
          preset
        );
      });
    }
  });

  describe('missing or absent', () => {
    it('returns undefined for null metadata', () => {
      expect(parseElectionPresetFromMetadata(null)).toBeUndefined();
    });

    it('returns undefined for undefined metadata', () => {
      expect(parseElectionPresetFromMetadata(undefined)).toBeUndefined();
    });

    it('returns undefined when meta is absent', () => {
      expect(parseElectionPresetFromMetadata({})).toBeUndefined();
    });

    it('returns undefined when meta.electionPreset is absent', () => {
      expect(parseElectionPresetFromMetadata({ meta: {} })).toBeUndefined();
    });
  });

  describe('legacy / unknown shapes', () => {
    it('ignores legacy ElectionResultsType shape if present in meta', () => {
      const legacy = {
        meta: { electionPreset: { name: 'single-choice-multiquestion', properties: {} } },
      };
      expect(parseElectionPresetFromMetadata(legacy)).toBeUndefined();
    });

    it('ignores unknown preset discriminator', () => {
      const unknown = { meta: { electionPreset: { type: 'borda' } } };
      expect(parseElectionPresetFromMetadata(unknown)).toBeUndefined();
    });

    it('ignores string electionPreset (not object)', () => {
      const malformed = { meta: { electionPreset: 'rating' } };
      expect(parseElectionPresetFromMetadata(malformed)).toBeUndefined();
    });
  });
});

describe('presets within the ballot circuit', () => {
  // A ballot each preset must accept, and one it must refuse, for nf choices.
  const fill = (n: number, v: number) => new Array<number>(n).fill(v);
  const cases: Array<[ElectionPreset, (nf: number) => number[], (nf: number) => number[]]> = [
    [{ type: 'single_choice' }, nf => [1, ...fill(nf - 1, 0)], nf => fill(nf, 0)],
    [
      { type: 'single_choice', allowAbstain: true },
      nf => fill(nf, 0),
      nf => [2, ...fill(nf - 1, 0)],
    ],
    [
      { type: 'multiple_choice', maxSelections: 1 },
      nf => fill(nf, 0),
      nf => [2, ...fill(nf - 1, 0)],
    ],
    [{ type: 'approval' }, nf => fill(nf, 1), nf => [2, ...fill(nf - 1, 0)]],
    [{ type: 'rating', maxValue: 5 }, nf => fill(nf, 5), nf => [6, ...fill(nf - 1, 0)]],
    [
      { type: 'ranking' },
      nf => Array.from({ length: nf }, (_, i) => nf - i),
      nf => (nf === 1 ? [0] : fill(nf, 1)),
    ],
    [
      { type: 'quadratic', budget: 16 },
      nf => [4, ...fill(nf - 1, 0)],
      nf => [4, 1, ...fill(nf - 2, 0)],
    ],
  ];

  it('builds, for 1 to 16 choices, a mode the registry takes and the circuit checks', () => {
    for (const [preset, valid, invalid] of cases) {
      for (let nf = 1; nf <= 16; nf++) {
        const mode = ballotModeValues(resolveElectionPreset(preset, questionsWith(nf)));
        expect(mode.numFields).toBe(nf);
        expect(checkBallot(valid(nf), mode, 1n), `${preset.type} nf=${nf}`).toEqual({
          valid: true,
        });
        // A quadratic ballot of one field cannot spend 4^2 + 1.
        if (preset.type === 'quadratic' && nf === 1) continue;
        expect(checkBallot(invalid(nf), mode, 1n).valid, `${preset.type} nf=${nf}`).toBe(false);
      }
    }
  });

  it('refuses more choices than the circuit has fields', () => {
    for (const [preset] of cases) {
      const err = (() => {
        try {
          resolveElectionPreset(preset, questionsWith(17));
        } catch (e) {
          return e;
        }
      })() as BallotModeError;
      expect(err).toBeInstanceOf(BallotModeError);
      expect(err.message).toContain(
        'questions[0] has 17 choices; the ballot circuit has 16 fields'
      );
      expect(err.registryError).toBe('InvalidMaxCount');
    }
  });

  it('refuses parameters that are not integers or do not fit the circuit', () => {
    expect(() =>
      resolveElectionPreset({ type: 'rating', maxValue: 2.5 }, questionsWith(3))
    ).toThrow("electionPreset 'rating': maxValue (2.5) must be an integer");
    expect(() =>
      resolveElectionPreset({ type: 'rating', maxValue: 5, minValue: -1 }, questionsWith(3))
    ).toThrow("electionPreset 'rating': minValue (-1) must be >= 0");
    expect(() =>
      resolveElectionPreset({ type: 'quadratic', budget: Number.NaN }, questionsWith(3))
    ).toThrow("electionPreset 'quadratic': budget (NaN) must be an integer");
    expect(() =>
      resolveElectionPreset({ type: 'multiple_choice', maxSelections: 1.5 }, questionsWith(3))
    ).toThrow('maxSelections (1.5) must be an integer');
    // Values are 48-bit in the circuit.
    expect(() =>
      resolveElectionPreset({ type: 'rating', maxValue: 2 ** 48 }, questionsWith(3))
    ).toThrow('maxValue 281474976710656 does not fit in 48 bits');
    expect(() =>
      resolveElectionPreset({ type: 'quadratic', budget: 2 ** 48 }, questionsWith(3))
    ).toThrow('maxValue 281474976710656 does not fit in 48 bits');
    expect(
      resolveElectionPreset({ type: 'rating', maxValue: 2 ** 48 - 1 }, questionsWith(16))
        .maxValueSum
    ).toBe(String(16 * (2 ** 48 - 1)));
    // A minimum spend above the budget has no ballot.
    expect(() =>
      resolveElectionPreset({ type: 'quadratic', budget: 4, minValueSum: 5 }, questionsWith(3))
    ).toThrow('minValueSum 5 exceeds maxValueSum 4');
  });
});

describe('ballotModeValues', () => {
  const base = {
    numFields: 4,
    maxValue: '3',
    minValue: '0',
    uniqueValues: false,
    costExponent: 1,
    maxValueSum: '6',
    minValueSum: '0',
  };
  const refusal = (mode: object) => {
    try {
      ballotModeValues({ ...base, ...mode });
    } catch (e) {
      return [(e as BallotModeError).registryError, (e as Error).message];
    }
    return undefined;
  };

  it('gives the integer form, groupSize defaulting to numFields', () => {
    expect(ballotModeValues(base)).toEqual({
      numFields: 4,
      groupSize: 4,
      uniqueValues: false,
      costExponent: 1,
      maxValue: 3n,
      minValue: 0n,
      maxValueSum: 6n,
      minValueSum: 0n,
    });
    expect(ballotModeValues({ ...base, groupSize: 1, maxValueSum: '0' }).groupSize).toBe(1);
  });

  it('refuses what the registry refuses, naming its error', () => {
    expect(refusal({ numFields: 0 })?.[0]).toBe('InvalidMaxCount');
    expect(refusal({ numFields: 17 })?.[0]).toBe('InvalidMaxCount');
    expect(refusal({ numFields: 2.5 })?.[0]).toBe('InvalidMaxCount');
    expect(refusal({ groupSize: 5 })?.[0]).toBe('InvalidGroupSize');
    expect(refusal({ minValue: '4' })?.[0]).toBe('InvalidMaxMinValueBounds');
    expect(refusal({ minValueSum: '7' })?.[0]).toBe('InvalidValueSumBounds');
    expect(refusal({ maxValueSum: '0', minValueSum: '1' })).toEqual([
      'InvalidValueSumBounds',
      'ballot mode: minValueSum 1 exceeds maxValueSum 0 (a zero maxValueSum makes the weight the budget)',
    ]);
    expect(refusal({ maxValue: String(2n ** 48n) })?.[0]).toBe('BallotModeMaxValueTooLarge');
    expect(refusal({ minValue: String(2n ** 48n), maxValue: String(2n ** 48n) })?.[0]).toBe(
      'BallotModeMaxValueTooLarge'
    );
    expect(refusal({ maxValueSum: String(2n ** 63n) })?.[0]).toBe('BallotModeMaxValueSumTooLarge');
    expect(
      refusal({ maxValueSum: String(2n ** 63n - 1n), minValueSum: String(2n ** 63n) })?.[0]
    ).toBe('BallotModeMinValueSumTooLarge');
  });

  it('refuses bounds and bytes that are not integers', () => {
    expect(refusal({ maxValue: '1.5' })?.[1]).toBe(
      'ballot mode: maxValue 1.5 is not a non-negative integer'
    );
    expect(refusal({ maxValue: '-1' })?.[1]).toContain('not a non-negative integer');
    expect(refusal({ maxValue: '0x10' })?.[1]).toContain('not a non-negative integer');
    expect(refusal({ costExponent: 256 })?.[1]).toBe(
      'ballot mode: costExponent 256 is not an integer in 0..255'
    );
    expect(refusal({ groupSize: -1 })?.[1]).toContain('groupSize -1 is not an integer');
    expect(refusal({ uniqueValues: 'true' })?.[1]).toBe(
      'ballot mode: uniqueValues true is not a boolean'
    );
  });
});
