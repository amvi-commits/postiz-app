module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/libraries/helpers/src/utils/*.spec.ts',
    '<rootDir>/apps/backend/src/services/sns-studio/*.spec.ts',
    '<rootDir>/libraries/nestjs-libraries/src/**/*.spec.ts',
  ],
  moduleNameMapper: {
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
    '^@gitroom/frontend/(.*)$': '<rootDir>/apps/frontend/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/libraries/helpers/src/$1',
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/libraries/nestjs-libraries/src/$1',
    '^@gitroom/react/(.*)$': '<rootDir>/libraries/react-shared-libraries/src/$1',
    '^bcrypt$': '<rootDir>/tests/mocks/bcrypt.cjs',
    '^nostr-tools$': '<rootDir>/tests/mocks/empty.cjs',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.jest.json',
      diagnostics: false,
    }],
  },
};
