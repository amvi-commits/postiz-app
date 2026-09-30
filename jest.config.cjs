module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/libraries/helpers/src/utils/*.spec.ts',
    '<rootDir>/apps/backend/src/services/sns-studio/*.spec.ts',
  ],
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/user/org\\.from\\.request$': '<rootDir>/libraries/nestjs-libraries/src/user/org.from.request',
    '^@gitroom/nestjs-libraries/database/prisma/prisma\\.service$': '<rootDir>/libraries/nestjs-libraries/src/database/prisma/prisma.service',
    '^@gitroom/nestjs-libraries/database/prisma/account-protection\\.service$': '<rootDir>/libraries/nestjs-libraries/src/database/prisma/account-protection.service',
    '^@gitroom/backend/(.*)$': '<rootDir>/apps/backend/src/$1',
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
