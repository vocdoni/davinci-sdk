/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^test/(.*)$': '<rootDir>/test/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
    }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  setupFilesAfterEnv: [],
  testTimeout: 120000,
  verbose: true,
  testMatch: [
    '<rootDir>/test/**/*.test.ts'
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testEnvironment: 'node',
  detectOpenHandles: false,
  forceExit: true,
  passWithNoTests: true,
};
