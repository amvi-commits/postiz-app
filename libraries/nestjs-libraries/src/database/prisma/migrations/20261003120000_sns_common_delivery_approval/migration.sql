-- Add per-delivery approval metadata for Common Publishing Phase 5.
-- This is additive and preserves all existing delivery records and settings.
ALTER TABLE "SnsDelivery"
    ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
