-- CreateTable
CREATE TABLE "AccountSecurityProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "securityState" TEXT NOT NULL DEFAULT 'HEALTHY',
    "automationPaused" BOOLEAN NOT NULL DEFAULT false,
    "pauseReason" TEXT,
    "secretRef" TEXT,
    "lastHealthyAt" TIMESTAMP(3),
    "lastWarningAt" TIMESTAMP(3),
    "lastChallengeAt" TIMESTAMP(3),
    "lastAuthFailureAt" TIMESTAMP(3),
    "lastSuccessfulActionAt" TIMESTAMP(3),
    "cooldownUntil" TIMESTAMP(3),
    "consecutiveAuthFailures" INTEGER NOT NULL DEFAULT 0,
    "consecutiveProviderFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSecurityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountBrowserProfile" (
    "id" TEXT NOT NULL,
    "securityProfileId" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "profilePath" TEXT NOT NULL,
    "browserEngine" TEXT NOT NULL DEFAULT 'chromium',
    "browserMajorVersion" TEXT,
    "locale" TEXT,
    "timezone" TEXT,
    "osFamily" TEXT,
    "status" TEXT NOT NULL DEFAULT 'MISSING',
    "lastOpenedAt" TIMESTAMP(3),
    "lastClosedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastSuccessfulSessionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountBrowserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSessionHealth" (
    "id" TEXT NOT NULL,
    "securityProfileId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "checkedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSessionHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountActionBudget" (
    "id" TEXT NOT NULL,
    "securityProfileId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "windowSeconds" INTEGER NOT NULL DEFAULT 60,
    "maxActions" INTEGER NOT NULL DEFAULT 1,
    "usedActions" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'SAFE_DEFAULT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountActionBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountCircuitState" (
    "id" TEXT NOT NULL,
    "securityProfileId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CLOSED',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "openedUntil" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountCircuitState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountExecutionLease" (
    "id" TEXT NOT NULL,
    "securityProfileId" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountExecutionLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSecurityAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "securityProfileId" TEXT,
    "accountId" TEXT,
    "provider" TEXT,
    "event" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSecurityAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountSecurityProfile_organizationId_provider_securityStat_idx" ON "AccountSecurityProfile"("organizationId", "provider", "securityState");

-- CreateIndex
CREATE INDEX "AccountSecurityProfile_securityState_cooldownUntil_idx" ON "AccountSecurityProfile"("securityState", "cooldownUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSecurityProfile_organizationId_accountType_accountId_key" ON "AccountSecurityProfile"("organizationId", "accountType", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountBrowserProfile_securityProfileId_key" ON "AccountBrowserProfile"("securityProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountBrowserProfile_profileKey_key" ON "AccountBrowserProfile"("profileKey");

-- CreateIndex
CREATE INDEX "AccountBrowserProfile_status_updatedAt_idx" ON "AccountBrowserProfile"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountSessionHealth_securityProfileId_key" ON "AccountSessionHealth"("securityProfileId");

-- CreateIndex
CREATE INDEX "AccountSessionHealth_provider_status_checkedAt_idx" ON "AccountSessionHealth"("provider", "status", "checkedAt");

-- CreateIndex
CREATE INDEX "AccountActionBudget_resetAt_idx" ON "AccountActionBudget"("resetAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountActionBudget_securityProfileId_provider_actionType_key" ON "AccountActionBudget"("securityProfileId", "provider", "actionType");

-- CreateIndex
CREATE INDEX "AccountCircuitState_state_openedUntil_idx" ON "AccountCircuitState"("state", "openedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AccountCircuitState_securityProfileId_provider_actionType_key" ON "AccountCircuitState"("securityProfileId", "provider", "actionType");

-- CreateIndex
CREATE UNIQUE INDEX "AccountExecutionLease_securityProfileId_key" ON "AccountExecutionLease"("securityProfileId");

-- CreateIndex
CREATE INDEX "AccountExecutionLease_expiresAt_idx" ON "AccountExecutionLease"("expiresAt");

-- CreateIndex
CREATE INDEX "AccountSecurityAuditLog_organizationId_createdAt_idx" ON "AccountSecurityAuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AccountSecurityAuditLog_securityProfileId_createdAt_idx" ON "AccountSecurityAuditLog"("securityProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "AccountSecurityAuditLog_provider_event_createdAt_idx" ON "AccountSecurityAuditLog"("provider", "event", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountSecurityProfile" ADD CONSTRAINT "AccountSecurityProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountBrowserProfile" ADD CONSTRAINT "AccountBrowserProfile_securityProfileId_fkey" FOREIGN KEY ("securityProfileId") REFERENCES "AccountSecurityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSessionHealth" ADD CONSTRAINT "AccountSessionHealth_securityProfileId_fkey" FOREIGN KEY ("securityProfileId") REFERENCES "AccountSecurityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountActionBudget" ADD CONSTRAINT "AccountActionBudget_securityProfileId_fkey" FOREIGN KEY ("securityProfileId") REFERENCES "AccountSecurityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountCircuitState" ADD CONSTRAINT "AccountCircuitState_securityProfileId_fkey" FOREIGN KEY ("securityProfileId") REFERENCES "AccountSecurityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountExecutionLease" ADD CONSTRAINT "AccountExecutionLease_securityProfileId_fkey" FOREIGN KEY ("securityProfileId") REFERENCES "AccountSecurityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSecurityAuditLog" ADD CONSTRAINT "AccountSecurityAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSecurityAuditLog" ADD CONSTRAINT "AccountSecurityAuditLog_securityProfileId_fkey" FOREIGN KEY ("securityProfileId") REFERENCES "AccountSecurityProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
