/** @type {import('jest').Config} */
export default {
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^test/(.*)$': '<rootDir>/test/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/**/unit/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/test/setup/unit.setup.ts'],
    },
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/**/integration/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/test/setup/integration.setup.ts'],
      maxWorkers: 1,
    },
  ],
  verbose: true,
};
