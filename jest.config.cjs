module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/libraries/helpers/src/utils/*.spec.ts',
    '<rootDir>/apps/backend/src/services/sns-studio/*.spec.ts',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.jest.json',
      diagnostics: false,
    }],
  },
};
