-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "igExtrasJson" JSONB;

-- AlterTable
ALTER TABLE "PostAsset" ADD COLUMN     "altText" TEXT,
ADD COLUMN     "userTagsJson" JSONB;
