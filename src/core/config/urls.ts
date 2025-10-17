import {
  EnvironmentConfig,
  Environment,
  ServiceUrls,
  ChainConfig,
  EnvironmentOptions,
} from './types';

/**
 * Default URL and chain configuration for all environments
 */
export const DEFAULT_ENVIRONMENT_URLS: EnvironmentConfig = {
  dev: {
    sequencer: 'https://sequencer-dev.davinci.vote',
    census: 'https://c3-dev.davinci.vote',
    chain: 'sepolia',
  },
  stg: {
    sequencer: 'https://sequencer1.davinci.vote',
    census: 'https://c3.davinci.vote',
    chain: 'sepolia',
  },
  prod: {
    // TODO: Add production URLs when available
    sequencer: '',
    census: '',
    chain: 'mainnet',
  },
};

/**
 * Get URLs and chain configuration for a specific environment
 */
export function getEnvironmentConfig(environment: Environment): ServiceUrls & ChainConfig {
  return DEFAULT_ENVIRONMENT_URLS[environment];
}

/**
 * Get only URLs for a specific environment
 */
export function getEnvironmentUrls(environment: Environment): ServiceUrls {
  const config = DEFAULT_ENVIRONMENT_URLS[environment];
  return {
    sequencer: config.sequencer,
    census: config.census,
  };
}

/**
 * Get chain configuration for a specific environment
 */
export function getEnvironmentChain(environment: Environment): ChainConfig['chain'] {
  return DEFAULT_ENVIRONMENT_URLS[environment].chain;
}

/**
 * Resolve URLs and chain based on environment and custom overrides
 */
export function resolveConfiguration(options: EnvironmentOptions = {}): ServiceUrls & ChainConfig {
  const environment = options.environment || 'prod';
  const defaultConfig = getEnvironmentConfig(environment);

  // Start with default configuration
  const resolvedConfig = { ...defaultConfig };

  // Override URLs if provided (only override with non-undefined values)
  if (options.customUrls) {
    if (options.customUrls.sequencer !== undefined) {
      resolvedConfig.sequencer = options.customUrls.sequencer;
    }
    if (options.customUrls.census !== undefined) {
      resolvedConfig.census = options.customUrls.census;
    }
  }

  // Override chain if provided
  if (options.customChain) {
    resolvedConfig.chain = options.customChain;
  }

  return resolvedConfig;
}

/**
 * Resolve only URLs based on environment and custom overrides
 */
export function resolveUrls(options: EnvironmentOptions = {}): ServiceUrls {
  const config = resolveConfiguration(options);
  return {
    sequencer: config.sequencer,
    census: config.census,
  };
}
