-- AlterTable
ALTER TABLE "EngagementComment" ADD COLUMN     "fireAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "EngagementComment_status_fireAt_idx" ON "EngagementComment"("status", "fireAt");
