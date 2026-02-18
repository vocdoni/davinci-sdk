import { config } from 'dotenv';
import { resolve } from 'path';

let loaded = false;

const ENV_PATH = resolve(process.cwd(), 'test/.env');
const DEFAULT_TIMEOUT_MS = 180_000;

function toPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function loadIntegrationEnv(): void {
  if (loaded) {
    return;
  }

  config({ path: ENV_PATH });

  if (!process.env.RPC_URL && process.env.SEPOLIA_RPC) {
    process.env.RPC_URL = process.env.SEPOLIA_RPC;
  }

  if (!process.env.SEPOLIA_RPC && process.env.RPC_URL) {
    process.env.SEPOLIA_RPC = process.env.RPC_URL;
  }

  if (!process.env.TIME_OUT && process.env.TIMEOUT) {
    process.env.TIME_OUT = process.env.TIMEOUT;
  }

  if (!process.env.TIMEOUT && process.env.TIME_OUT) {
    process.env.TIMEOUT = process.env.TIME_OUT;
  }

  loaded = true;
}

export function getIntegrationTimeoutMs(): number {
  loadIntegrationEnv();

  return (
    toPositiveInt(process.env.TIME_OUT) ??
    toPositiveInt(process.env.TIMEOUT) ??
    DEFAULT_TIMEOUT_MS
  );
}

export function getRequiredEnv(name: string): string {
  loadIntegrationEnv();

  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required integration env var ${name}. Add it to test/.env or your shell environment.`
    );
  }

  return value;
}

export function getOptionalEnv(name: string): string | undefined {
  loadIntegrationEnv();
  return process.env[name];
}

export function requireEnvVars(names: string[]): Record<string, string> {
  return names.reduce<Record<string, string>>((acc, name) => {
    acc[name] = getRequiredEnv(name);
    return acc;
  }, {});
}
