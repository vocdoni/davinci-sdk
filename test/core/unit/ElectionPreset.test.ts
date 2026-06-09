import { describe, expect, it } from 'vitest';
import {
  ElectionPreset,
  resolveElectionPreset,
} from '../../../src/core/types/ballot';

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
      const ballot = resolveElectionPreset(
        { type: 'single_choice' },
        questionsWith(5),
      );
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
        questionsWith(3),
      );
      expect(ballot.minValueSum).toBe('0');
      expect(ballot.maxValueSum).toBe('1');
    });
  });

  describe('multiple_choice', () => {
    it('uses minSelections=0 by default', () => {
      const ballot = resolveElectionPreset(
        { type: 'multiple_choice', maxSelections: 3 },
        questionsWith(5),
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
        questionsWith(5),
      );
      expect(ballot.minValueSum).toBe('2');
      expect(ballot.maxValueSum).toBe('4');
    });

    it('rejects maxSelections > numFields', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'multiple_choice', maxSelections: 7 },
          questionsWith(5),
        ),
      ).toThrow(/maxSelections \(7\) cannot exceed numFields \(5\)/);
    });

    it('rejects minSelections > maxSelections', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'multiple_choice', minSelections: 4, maxSelections: 2 },
          questionsWith(5),
        ),
      ).toThrow(/minSelections \(4\) cannot exceed maxSelections \(2\)/);
    });

    it('rejects maxSelections < 1', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'multiple_choice', maxSelections: 0 },
          questionsWith(5),
        ),
      ).toThrow(/maxSelections must be >= 1/);
    });

    it('rejects negative minSelections', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'multiple_choice', minSelections: -1, maxSelections: 2 },
          questionsWith(5),
        ),
      ).toThrow(/minSelections \(-1\) cannot be negative/);
    });
  });

  describe('approval', () => {
    it('caps maxValueSum at numFields', () => {
      const ballot = resolveElectionPreset(
        { type: 'approval' },
        questionsWith(4),
      );
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
      const ballot = resolveElectionPreset(
        { type: 'rating', maxValue: 5 },
        questionsWith(3),
      );
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
        questionsWith(2),
      );
      expect(ballot.minValue).toBe('1');
      expect(ballot.maxValue).toBe('10');
      expect(ballot.minValueSum).toBe('2');
      expect(ballot.maxValueSum).toBe('20');
    });

    it('rejects maxValue <= minValue', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'rating', minValue: 5, maxValue: 5 },
          questionsWith(2),
        ),
      ).toThrow(/maxValue \(5\) must be greater than minValue \(5\)/);
    });
  });

  describe('ranking', () => {
    it('sets exact permutation sum for n=3', () => {
      const ballot = resolveElectionPreset(
        { type: 'ranking' },
        questionsWith(3),
      );
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
      const ballot = resolveElectionPreset(
        { type: 'ranking' },
        questionsWith(5),
      );
      expect(ballot.minValueSum).toBe('15');
      expect(ballot.maxValueSum).toBe('15');
      expect(ballot.maxValue).toBe('5');
    });

    it('sets exact permutation sum for n=10', () => {
      const ballot = resolveElectionPreset(
        { type: 'ranking' },
        questionsWith(10),
      );
      expect(ballot.minValueSum).toBe('55');
      expect(ballot.maxValueSum).toBe('55');
    });
  });

  describe('quadratic', () => {
    it('uses minValueSum=0 by default', () => {
      const ballot = resolveElectionPreset(
        { type: 'quadratic', budget: 100 },
        questionsWith(4),
      );
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
        questionsWith(3),
      );
      expect(ballot.minValueSum).toBe('10');
    });

    it('rejects budget <= 0', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'quadratic', budget: 0 },
          questionsWith(3),
        ),
      ).toThrow(/budget \(0\) must be > 0/);
    });

    it('rejects negative minValueSum', () => {
      expect(() =>
        resolveElectionPreset(
          { type: 'quadratic', budget: 50, minValueSum: -1 },
          questionsWith(3),
        ),
      ).toThrow(/minValueSum \(-1\) must be >= 0/);
    });
  });

  describe('cross-cutting validation', () => {
    it('rejects empty questions array', () => {
      expect(() =>
        resolveElectionPreset({ type: 'approval' }, []),
      ).toThrow(/requires at least one question/);
    });

    it('rejects questions[0] with no choices', () => {
      expect(() =>
        resolveElectionPreset({ type: 'approval' }, [{ choices: [] }]),
      ).toThrow(/questions\[0\]\.choices to be non-empty/);
    });
  });
});
