-- Account: token-refresh health columns (visibility for silent refresh failures)
ALTER TABLE "Account" ADD COLUMN "lastRefreshAt" TIMESTAMP(3);
ALTER TABLE "Account" ADD COLUMN "lastRefreshError" TEXT;

-- Post: real publishedAt column (never moves on edit, unlike updatedAt)
ALTER TABLE "Post" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- One-time backfill: existing published posts get publishedAt = updatedAt as the
-- best available proxy at migration time. All future publishes / backfills set
-- it precisely.
UPDATE "Post" SET "publishedAt" = "updatedAt" WHERE "status" = 'published' AND "publishedAt" IS NULL;
