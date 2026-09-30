import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(__dirname, '..', 'fixtures');

/** Raw text of a fixture under `test/fixtures/`. */
export function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

/**
 * Parses a JSON fixture. Integers of 16 digits or more (vote ids, slots) are
 * read as strings so they keep every digit; convert them with `BigInt`.
 */
export function loadFixture<T>(path: string): T {
  const raw = readFixture(path).replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  return JSON.parse(raw) as T;
}

/** A decimal string, or a JSON number or bigint string, as a bigint. */
export function big(v: string | number): bigint {
  return BigInt(v);
}
