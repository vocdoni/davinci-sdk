import { describe, expect, it } from 'vitest';
import { ProcessStatus } from '../../../src/contracts';
import { graceEndOf, processPhase } from '../../../src/core';

// The cases of davinci-contracts `test/Grace.t.sol` (36c0b0a): production
// bounds (grace 180, cap 1800) and the anvil ones (grace 60, cap 60).
const START = 1_000_000n;
const DURATION = 3_600n;
const END = START + DURATION;
const UINT256_MAX = (1n << 256n) - 1n;
const window = (grace: number, lastVoteAt = 0n, duration = DURATION) => ({
  startTime: START,
  duration,
  grace,
  lastVoteAt,
});

describe('graceEndOf', () => {
  it('is the end plus the grace until a batch lands after the end', () => {
    expect(graceEndOf(window(180), 1_800)).toBe(END + 180n);
    // test_GraceEnd_TransitionBeforeTheEnd: a landing before the end does not move it.
    expect(graceEndOf(window(180, END - 1000n), 1_800)).toBe(END + 180n);
  });

  it('restarts from every batch recorded after the end (test_GraceEnd_IdleExtension)', () => {
    expect(graceEndOf(window(180, END + 100n), 1_800)).toBe(END + 100n + 180n);
    expect(graceEndOf(window(180, END + 180n + 50n), 1_800)).toBe(END + 180n + 50n + 180n);
  });

  it('never runs past the cap after the end', () => {
    expect(graceEndOf(window(60, END + 30n), 60)).toBe(END + 60n);
    expect(graceEndOf(window(60, END + 59n), 60)).toBe(END + 60n);
  });

  it('matches the contract formula over a range of values (testFuzz_GraceEnd_Formula)', () => {
    for (const grace of [150, 180, 600]) {
      for (const last of [0n, END - 1n, END, END + 1n, END + 900n, END + 1_700n, END + 1_800n]) {
        const idle = (last > END ? last : END) + BigInt(grace);
        const cap = END + 1_800n;
        expect(graceEndOf(window(grace, last), 1_800n)).toBe(idle < cap ? idle : cap);
      }
    }
  });

  it('never closes for an end within the cap of 2^256 (test_GraceEnd_MaxEndDoesNotOverflow)', () => {
    expect(graceEndOf(window(180, 0n, UINT256_MAX - START), 1_800)).toBe(UINT256_MAX);
    expect(graceEndOf(window(180, END, UINT256_MAX - START - 1_800n), 1_800)).toBe(
      UINT256_MAX - 1_800n + 180n
    );
  });
});

describe('processPhase', () => {
  const p = (status: ProcessStatus) => ({ status, startTime: START, duration: DURATION });
  const graceEnd = END + 180n;

  it('reads the clock and the grace window', () => {
    expect(processPhase(p(ProcessStatus.READY), START - 1n, graceEnd)).toBe('upcoming');
    expect(processPhase(p(ProcessStatus.READY), START, graceEnd)).toBe('open');
    expect(processPhase(p(ProcessStatus.READY), END - 1n, graceEnd)).toBe('open');
    expect(processPhase(p(ProcessStatus.READY), END, graceEnd)).toBe('closing');
    expect(processPhase(p(ProcessStatus.READY), graceEnd - 1n, graceEnd)).toBe('closing');
    expect(processPhase(p(ProcessStatus.READY), graceEnd, graceEnd)).toBe('ended');
  });

  it('treats a pause and an early end like READY once the end has passed', () => {
    expect(processPhase(p(ProcessStatus.PAUSED), START - 1n, graceEnd)).toBe('paused');
    expect(processPhase(p(ProcessStatus.PAUSED), END - 1n, graceEnd)).toBe('paused');
    // A pause does not outlive the end: the window records batches.
    expect(processPhase(p(ProcessStatus.PAUSED), END, graceEnd)).toBe('closing');
    expect(processPhase(p(ProcessStatus.PAUSED), graceEnd, graceEnd)).toBe('ended');
    // ENDED moved the end to its block; a clock behind it reads closing.
    expect(processPhase(p(ProcessStatus.ENDED), END - 1n, graceEnd)).toBe('closing');
    expect(processPhase(p(ProcessStatus.ENDED), END + 1n, graceEnd)).toBe('closing');
    expect(processPhase(p(ProcessStatus.ENDED), graceEnd + 1n, graceEnd)).toBe('ended');
  });

  it('keeps the terminal statuses whatever the clock', () => {
    for (const now of [START - 1n, END, graceEnd + 1n]) {
      expect(processPhase(p(ProcessStatus.RESULTS), now, graceEnd)).toBe('results');
      expect(processPhase(p(ProcessStatus.CANCELED), now, graceEnd)).toBe('canceled');
    }
  });
});
