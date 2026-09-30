import { config } from 'dotenv';
import { resolve } from 'path';

let loaded = false;

/**
 * Loads `test/.env` into `process.env` once, for the suites that need
 * settings (see `test/.env.example`); variables already set win.
 */
export function loadIntegrationEnv(): void {
  if (loaded) return;
  config({ path: resolve(process.cwd(), 'test/.env') });
  loaded = true;
}
