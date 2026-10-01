module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/libraries/helpers/src/utils/*.spec.ts',
    '**/apps/backend/src/services/sns-studio/*.spec.ts',
    '**/apps/backend/src/api/routes/*.spec.ts',
  ],
  moduleNameMapper: {
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/frontend/(.*)$': '<rootDir>/apps/frontend/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/libraries/nestjs-libraries/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.jest.json',
      diagnostics: false,
    }],
  },
};
