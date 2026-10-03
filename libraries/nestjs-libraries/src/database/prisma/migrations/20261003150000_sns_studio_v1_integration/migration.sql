-- AlterTable
ALTER TABLE "SnsMediaAsset" ADD COLUMN     "assetType" TEXT DEFAULT 'ORIGINAL',
ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "SnsPublishRecord" ADD COLUMN     "integrationId" TEXT,
ADD COLUMN     "platform" TEXT NOT NULL DEFAULT 'INSTAGRAM',
ADD COLUMN     "postId" TEXT,
ADD COLUMN     "title" TEXT,
ALTER COLUMN "accountId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "SnsMediaAsset_organizationId_parentId_idx" ON "SnsMediaAsset"("organizationId", "parentId");

-- CreateIndex
CREATE INDEX "SnsPublishRecord_integrationId_status_publishedAt_idx" ON "SnsPublishRecord"("integrationId", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "SnsPublishRecord_platform_status_idx" ON "SnsPublishRecord"("platform", "status");

-- AddForeignKey
ALTER TABLE "SnsMediaAsset" ADD CONSTRAINT "SnsMediaAsset_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "SnsMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
