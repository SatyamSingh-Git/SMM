-- CreateTable
CREATE TABLE "PostInsight" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reach" INTEGER,
    "impressions" INTEGER,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "saves" INTEGER,
    "shares" INTEGER,
    "reposts" INTEGER,
    "quotes" INTEGER,
    "profileVisits" INTEGER,
    "follows" INTEGER,
    "rawJson" JSONB,

    CONSTRAINT "PostInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followers" INTEGER NOT NULL,
    "following" INTEGER,
    "postsCount" INTEGER,

    CONSTRAINT "AccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostInsight_postId_capturedAt_idx" ON "PostInsight"("postId", "capturedAt");

-- CreateIndex
CREATE INDEX "AccountSnapshot_accountId_capturedAt_idx" ON "AccountSnapshot"("accountId", "capturedAt");

-- AddForeignKey
ALTER TABLE "PostInsight" ADD CONSTRAINT "PostInsight_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountSnapshot" ADD CONSTRAINT "AccountSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
