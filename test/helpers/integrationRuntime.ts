import { JsonRpcProvider, Wallet } from 'ethers';
import { getRequiredEnv, requireEnvVars } from './integrationEnv';

export function createIntegrationProvider(): JsonRpcProvider {
  return new JsonRpcProvider(getRequiredEnv('RPC_URL'));
}

export function createIntegrationWallet(): Wallet {
  const provider = createIntegrationProvider();
  return new Wallet(getRequiredEnv('PRIVATE_KEY'), provider);
}

export function getApiUrls(): { sequencerUrl: string; censusUrl: string } {
  const env = requireEnvVars(['SEQUENCER_API_URL', 'CENSUS_API_URL']);
  return {
    sequencerUrl: env.SEQUENCER_API_URL,
    censusUrl: env.CENSUS_API_URL,
  };
}
