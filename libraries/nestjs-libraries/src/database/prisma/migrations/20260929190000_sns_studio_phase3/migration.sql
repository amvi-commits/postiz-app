-- Additive and repeat-safe Phase 3 schema changes.
-- This migration only adds SNS Studio content-planning tables and constraints.
-- It does not alter Post, SnsPublishRecord, or Instagram-specific tables.
CREATE TABLE IF NOT EXISTS "SnsContent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT,
    "commonContent" TEXT NOT NULL DEFAULT '',
    "commonHashtags" JSONB,
    "commonScheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "originalAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SnsContent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SnsContentVariant" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SnsContentVariant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SnsContentPlatformOverride" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "contentOverride" TEXT,
    "hashtagsOverride" JSONB,
    "scheduledAtOverride" TIMESTAMP(3),
    "settingsOverride" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SnsContentPlatformOverride_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SnsDelivery" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "variantId" TEXT,
    "integrationId" TEXT NOT NULL,
    "providerIdentifier" TEXT NOT NULL,
    "accountName" TEXT,
    "contentOverride" TEXT,
    "hashtagsOverride" JSONB,
    "scheduledAtOverride" TIMESTAMP(3),
    "settingsOverride" JSONB,
    "providerSettingsSnapshot" JSONB,
    "resolvedContent" TEXT,
    "resolvedHashtags" JSONB,
    "resolvedScheduledAt" TIMESTAMP(3),
    "postId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SnsDelivery_pkey" PRIMARY KEY ("id")
);

-- Adds the field to early development schemas that already contain SnsDelivery.
ALTER TABLE "SnsDelivery"
    ADD COLUMN IF NOT EXISTS "providerSettingsSnapshot" JSONB;

CREATE INDEX IF NOT EXISTS "SnsContent_organizationId_status_updatedAt_idx"
    ON "SnsContent"("organizationId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "SnsContent_originalAssetId_idx"
    ON "SnsContent"("originalAssetId");
CREATE INDEX IF NOT EXISTS "SnsContentVariant_contentId_isDefault_idx"
    ON "SnsContentVariant"("contentId", "isDefault");
CREATE INDEX IF NOT EXISTS "SnsContentVariant_mediaAssetId_idx"
    ON "SnsContentVariant"("mediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "SnsContentVariant_contentId_mediaAssetId_key"
    ON "SnsContentVariant"("contentId", "mediaAssetId");
CREATE INDEX IF NOT EXISTS "SnsContentPlatformOverride_contentId_idx"
    ON "SnsContentPlatformOverride"("contentId");
CREATE UNIQUE INDEX IF NOT EXISTS "SnsContentPlatformOverride_contentId_platform_key"
    ON "SnsContentPlatformOverride"("contentId", "platform");
CREATE INDEX IF NOT EXISTS "SnsDelivery_contentId_status_idx"
    ON "SnsDelivery"("contentId", "status");
CREATE INDEX IF NOT EXISTS "SnsDelivery_integrationId_idx"
    ON "SnsDelivery"("integrationId");
CREATE INDEX IF NOT EXISTS "SnsDelivery_providerIdentifier_idx"
    ON "SnsDelivery"("providerIdentifier");
CREATE INDEX IF NOT EXISTS "SnsDelivery_postId_idx"
    ON "SnsDelivery"("postId");
CREATE UNIQUE INDEX IF NOT EXISTS "SnsDelivery_contentId_integrationId_key"
    ON "SnsDelivery"("contentId", "integrationId");

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SnsContent_organizationId_fkey' AND conrelid = '"SnsContent"'::regclass) THEN
        ALTER TABLE "SnsContent" ADD CONSTRAINT "SnsContent_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SnsContent_originalAssetId_fkey' AND conrelid = '"SnsContent"'::regclass) THEN
        ALTER TABLE "SnsContent" ADD CONSTRAINT "SnsContent_originalAssetId_fkey"
        FOREIGN KEY ("originalAssetId") REFERENCES "SnsMediaAsset"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SnsContentVariant_contentId_fkey' AND conrelid = '"SnsContentVariant"'::regclass) THEN
        ALTER TABLE "SnsContentVariant" ADD CONSTRAINT "SnsContentVariant_contentId_fkey"
        FOREIGN KEY ("contentId") REFERENCES "SnsContent"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SnsContentVariant_mediaAssetId_fkey' AND conrelid = '"SnsContentVariant"'::regclass) THEN
        ALTER TABLE "SnsContentVariant" ADD CONSTRAINT "SnsContentVariant_mediaAssetId_fkey"
        FOREIGN KEY ("mediaAssetId") REFERENCES "SnsMediaAsset"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SnsContentPlatformOverride_contentId_fkey' AND conrelid = '"SnsContentPlatformOverride"'::regclass) THEN
        ALTER TABLE "SnsContentPlatformOverride" ADD CONSTRAINT "SnsContentPlatformOverride_contentId_fkey"
        FOREIGN KEY ("contentId") REFERENCES "SnsContent"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SnsDelivery_contentId_fkey' AND conrelid = '"SnsDelivery"'::regclass) THEN
        ALTER TABLE "SnsDelivery" ADD CONSTRAINT "SnsDelivery_contentId_fkey"
        FOREIGN KEY ("contentId") REFERENCES "SnsContent"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SnsDelivery_variantId_fkey' AND conrelid = '"SnsDelivery"'::regclass) THEN
        ALTER TABLE "SnsDelivery" ADD CONSTRAINT "SnsDelivery_variantId_fkey"
        FOREIGN KEY ("variantId") REFERENCES "SnsContentVariant"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
