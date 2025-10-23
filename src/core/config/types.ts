/**
 * Supported environment types
 */
export type Environment = 'dev' | 'stg' | 'prod';

/**
 * URL configuration for each service
 */
export interface ServiceUrls {
  /** Sequencer API URL */
  sequencer: string;
  /** Census API URL */
  census: string;
}

/**
 * Chain configuration for each environment
 */
export interface ChainConfig {
  /** Chain name/ID */
  chain: 'sepolia' | 'mainnet' | 'celo';
}

/**
 * Environment-based URL configuration
 */
export interface EnvironmentConfig {
  dev: ServiceUrls & ChainConfig;
  stg: ServiceUrls & ChainConfig;
  prod: ServiceUrls & ChainConfig;
}

/**
 * Configuration options for environment setup
 */
export interface EnvironmentOptions {
  /** Environment to use (defaults to 'prod') */
  environment?: Environment;
  /** Custom URLs to override defaults */
  customUrls?: Partial<ServiceUrls>;
  /** Custom chain to override default */
  customChain?: ChainConfig['chain'];
}
