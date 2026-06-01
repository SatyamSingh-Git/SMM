-- CreateEnum
CREATE TYPE "EngagementStatus" AS ENUM ('new', 'queued', 'replying', 'replied', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "EngagementComment" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformCommentId" TEXT NOT NULL,
    "postId" TEXT,
    "platformPostId" TEXT NOT NULL,
    "parentPlatformId" TEXT,
    "postCaption" TEXT,
    "authorUsername" TEXT,
    "authorPlatformId" TEXT,
    "text" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EngagementStatus" NOT NULL DEFAULT 'new',
    "agentReplyText" TEXT,
    "agentPlatformReplyId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StyleExample" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "questionText" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "postContext" TEXT,
    "platformReplyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StyleExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EngagementComment_platformCommentId_key" ON "EngagementComment"("platformCommentId");

-- CreateIndex
CREATE INDEX "EngagementComment_status_receivedAt_idx" ON "EngagementComment"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "EngagementComment_platformPostId_idx" ON "EngagementComment"("platformPostId");

-- CreateIndex
CREATE INDEX "EngagementComment_authorPlatformId_idx" ON "EngagementComment"("authorPlatformId");

-- CreateIndex
CREATE UNIQUE INDEX "StyleExample_platformReplyId_key" ON "StyleExample"("platformReplyId");

-- CreateIndex
CREATE INDEX "StyleExample_platform_createdAt_idx" ON "StyleExample"("platform", "createdAt");
