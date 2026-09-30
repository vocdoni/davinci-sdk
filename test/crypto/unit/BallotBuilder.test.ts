import { describe, expect, it } from 'vitest';
import {
  fromRTEtoTE,
  fromTEtoRTE,
  FIELD_MODULUS,
  SCALING_FACTOR,
} from '../../../src/crypto/BallotBuilder';

describe('BallotBuilder coordinate transforms', () => {
  // A small grab-bag of (x, y) inputs in the BN254 scalar field.
  // We don't require them to be on the curve — these tests cover only
  // the algebraic round-trip of the transform itself.
  const samples: Array<[bigint, bigint]> = [
    [1n, 2n],
    [SCALING_FACTOR, 0n],
    [FIELD_MODULUS - 1n, FIELD_MODULUS - 1n],
    [0x1234567890abcdef1234567890abcdefn, 0xfedcba0987654321fedcba0987654321n],
    [FIELD_MODULUS / 2n, FIELD_MODULUS / 3n + 1n],
  ];

  it('FIELD_MODULUS is the BN254 scalar field modulus', () => {
    expect(FIELD_MODULUS).toBe(
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
    );
  });

  it('SCALING_FACTOR is strictly less than FIELD_MODULUS', () => {
    expect(SCALING_FACTOR < FIELD_MODULUS).toBe(true);
    expect(SCALING_FACTOR > 0n).toBe(true);
  });

  describe('fromRTEtoTE', () => {
    it('preserves the y coordinate', () => {
      for (const [x, y] of samples) {
        const [, yTE] = fromRTEtoTE(x, y);
        expect(yTE).toBe(y);
      }
    });

    it('produces coordinates inside the field', () => {
      for (const [x, y] of samples) {
        const [xTE, yTE] = fromRTEtoTE(x, y);
        expect(xTE >= 0n && xTE < FIELD_MODULUS).toBe(true);
        expect(yTE >= 0n && yTE < FIELD_MODULUS).toBe(true);
      }
    });
  });

  describe('fromTEtoRTE', () => {
    it('preserves the y coordinate', () => {
      for (const [x, y] of samples) {
        const [, yRTE] = fromTEtoRTE(x, y);
        expect(yRTE).toBe(y);
      }
    });
  });

  describe('round-trip RTE -> TE -> RTE', () => {
    it('recovers the original (x, y) for every sample', () => {
      for (const [x, y] of samples) {
        const [xTE, yTE] = fromRTEtoTE(x, y);
        const [xBack, yBack] = fromTEtoRTE(xTE, yTE);
        expect(xBack).toBe(x);
        expect(yBack).toBe(y);
      }
    });
  });

  describe('round-trip TE -> RTE -> TE', () => {
    it('recovers the original (x, y) for every sample', () => {
      for (const [x, y] of samples) {
        const [xRTE, yRTE] = fromTEtoRTE(x, y);
        const [xBack, yBack] = fromRTEtoTE(xRTE, yRTE);
        expect(xBack).toBe(x);
        expect(yBack).toBe(y);
      }
    });
  });
});
