-- AlterTable
ALTER TABLE "SnsMediaAsset" ADD COLUMN     "assetType" TEXT DEFAULT 'ORIGINAL',
ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "SnsPublishRecord" ADD COLUMN     "integrationId" TEXT,
ADD COLUMN     "platform" TEXT NOT NULL DEFAULT 'INSTAGRAM',
ADD COLUMN     "postId" TEXT,
ADD COLUMN     "title" TEXT,
ALTER COLUMN "accountId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SnsThreadsPostMetadata" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "isGhostPost" BOOLEAN NOT NULL DEFAULT false,
    "ghostExpiresAt" TIMESTAMP(3),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "topicTag" TEXT,
    "locationId" TEXT,
    "locationName" TEXT,
    "hasPoll" BOOLEAN NOT NULL DEFAULT false,
    "hasSpoiler" BOOLEAN NOT NULL DEFAULT false,
    "hasTextAttachment" BOOLEAN NOT NULL DEFAULT false,
    "quotePostId" TEXT,
    "replyControl" TEXT,
    "replyApprovalsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "templateId" TEXT,
    "referencePostId" TEXT,
    "characterCount" INTEGER NOT NULL DEFAULT 0,
    "threadCount" INTEGER NOT NULL DEFAULT 1,
    "mediaType" TEXT,
    "rawSettings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnsThreadsPostMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnsThreadsInboxItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "threadsMediaId" TEXT NOT NULL,
    "threadsReplyId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderUsername" TEXT NOT NULL,
    "senderProfilePic" TEXT,
    "text" TEXT NOT NULL,
    "postSnippet" TEXT,
    "itemType" TEXT NOT NULL DEFAULT 'REPLY',
    "status" TEXT NOT NULL DEFAULT 'UNHANDLED',
    "approvalStatus" TEXT,
    "isPendingApproval" BOOLEAN NOT NULL DEFAULT false,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "parentReplyId" TEXT,
    "repliedAt" TIMESTAMP(3) NOT NULL,
    "handledAt" TIMESTAMP(3),
    "ourReplyId" TEXT,
    "ourReplyText" TEXT,
    "aiDraftText" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnsThreadsInboxItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnsThreadsReferencePost" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "threadsPostId" TEXT NOT NULL,
    "authorUsername" TEXT NOT NULL,
    "authorProfilePic" TEXT,
    "content" TEXT NOT NULL,
    "mediaUrls" JSONB,
    "topicTag" TEXT,
    "permalink" TEXT,
    "likesCount" INTEGER NOT NULL DEFAULT 0,
    "repliesCount" INTEGER NOT NULL DEFAULT 0,
    "repostsCount" INTEGER NOT NULL DEFAULT 0,
    "quotesCount" INTEGER NOT NULL DEFAULT 0,
    "viewsCount" INTEGER NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "category" TEXT,
    "notes" TEXT,
    "analysisTags" JSONB,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnsThreadsReferencePost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnsThreadsAccountSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "displayName" TEXT,
    "autoPostEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultReplyControl" TEXT NOT NULL DEFAULT 'everyone',
    "aiReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyRules" JSONB,
    "maxPostsPerDay" INTEGER NOT NULL DEFAULT 10,
    "maxRepliesPerDay" INTEGER NOT NULL DEFAULT 50,
    "defaultPostTimes" JSONB,
    "aiCharacter" TEXT,
    "tone" TEXT NOT NULL DEFAULT 'polite',
    "ngWords" JSONB,
    "autoPlugEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoPlugRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnsThreadsAccountSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnsThreadsAutomationRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT,
    "ruleType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "triggerCount" INTEGER NOT NULL DEFAULT 0,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnsThreadsAutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SnsThreadsPostMetadata_postId_key" ON "SnsThreadsPostMetadata"("postId");

-- CreateIndex
CREATE INDEX "SnsThreadsPostMetadata_organizationId_isGhostPost_idx" ON "SnsThreadsPostMetadata"("organizationId", "isGhostPost");

-- CreateIndex
CREATE INDEX "SnsThreadsPostMetadata_organizationId_isArchived_idx" ON "SnsThreadsPostMetadata"("organizationId", "isArchived");

-- CreateIndex
CREATE INDEX "SnsThreadsPostMetadata_ghostExpiresAt_idx" ON "SnsThreadsPostMetadata"("ghostExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SnsThreadsInboxItem_threadsReplyId_key" ON "SnsThreadsInboxItem"("threadsReplyId");

-- CreateIndex
CREATE INDEX "SnsThreadsInboxItem_organizationId_integrationId_status_idx" ON "SnsThreadsInboxItem"("organizationId", "integrationId", "status");

-- CreateIndex
CREATE INDEX "SnsThreadsInboxItem_threadsMediaId_idx" ON "SnsThreadsInboxItem"("threadsMediaId");

-- CreateIndex
CREATE INDEX "SnsThreadsInboxItem_repliedAt_idx" ON "SnsThreadsInboxItem"("repliedAt");

-- CreateIndex
CREATE INDEX "SnsThreadsReferencePost_organizationId_category_idx" ON "SnsThreadsReferencePost"("organizationId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "SnsThreadsReferencePost_organizationId_threadsPostId_key" ON "SnsThreadsReferencePost"("organizationId", "threadsPostId");

-- CreateIndex
CREATE UNIQUE INDEX "SnsThreadsAccountSetting_integrationId_key" ON "SnsThreadsAccountSetting"("integrationId");

-- CreateIndex
CREATE INDEX "SnsThreadsAccountSetting_organizationId_idx" ON "SnsThreadsAccountSetting"("organizationId");

-- CreateIndex
CREATE INDEX "SnsThreadsAutomationRule_organizationId_ruleType_active_idx" ON "SnsThreadsAutomationRule"("organizationId", "ruleType", "active");

-- CreateIndex
CREATE INDEX "SnsMediaAsset_organizationId_parentId_idx" ON "SnsMediaAsset"("organizationId", "parentId");

-- CreateIndex
CREATE INDEX "SnsPublishRecord_integrationId_status_publishedAt_idx" ON "SnsPublishRecord"("integrationId", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "SnsPublishRecord_platform_status_idx" ON "SnsPublishRecord"("platform", "status");

-- AddForeignKey
ALTER TABLE "SnsMediaAsset" ADD CONSTRAINT "SnsMediaAsset_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "SnsMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnsThreadsPostMetadata" ADD CONSTRAINT "SnsThreadsPostMetadata_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnsThreadsInboxItem" ADD CONSTRAINT "SnsThreadsInboxItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnsThreadsReferencePost" ADD CONSTRAINT "SnsThreadsReferencePost_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnsThreadsAccountSetting" ADD CONSTRAINT "SnsThreadsAccountSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnsThreadsAutomationRule" ADD CONSTRAINT "SnsThreadsAutomationRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
