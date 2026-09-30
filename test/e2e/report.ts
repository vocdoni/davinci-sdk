/**
 * @fileoverview The run's summary: one row per scenario.
 */

/** How a scenario went. */
export interface Row {
  scenario: string;
  processId?: string;
  keyMode: string;
  origin: string;
  /** Ballots counted in the tally (the registry's `votersCount`). */
  voters?: number;
  /** `pass`, or the first error. */
  result: string;
  /** Milliseconds. */
  duration: number;
}

const minutes = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The rows as a fixed-width table. */
export function formatTable(rows: readonly Row[]): string {
  const cells = rows.map(r => [
    r.scenario,
    r.processId ?? '-',
    r.keyMode,
    r.origin,
    r.voters === undefined ? '-' : String(r.voters),
    r.result.split('\n')[0].slice(0, 120),
    minutes(r.duration),
  ]);
  const head = ['scenario', 'process id', 'key', 'origin', 'voters', 'result', 'time'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
  const line = (c: string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(head), line(widths.map(w => '-'.repeat(w))), ...cells.map(line)].join('\n');
}
