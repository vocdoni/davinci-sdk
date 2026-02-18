import { CensusOrigin } from '../../src/census/types';
import type { ProcessConfig } from '../../src';

export function randomHex(bytes: number): string {
  let hex = '';
  for (let i = 0; i < bytes * 2; i++) {
    hex += Math.floor(Math.random() * 16).toString(16);
  }

  return `0x${hex}`;
}

export function createOffchainProcessConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
  const censusRoot = randomHex(32);

  return {
    title: `Integration Test ${Date.now()}`,
    description: 'Auto-generated test process',
    census: {
      type: CensusOrigin.OffchainStatic,
      root: censusRoot,
      size: 10,
      uri: `ipfs://test-census-${Date.now()}`,
    },
    maxVoters: 10,
    ballot: {
      numFields: 1,
      maxValue: '1',
      minValue: '0',
      uniqueValues: false,
      costFromWeight: false,
      costExponent: 1,
      maxValueSum: '1',
      minValueSum: '0',
    },
    timing: {
      duration: 3600,
    },
    questions: [
      {
        title: 'Default question',
        choices: [
          { title: 'Yes', value: 0 },
          { title: 'No', value: 1 },
        ],
      },
    ],
    ...overrides,
  };
}
