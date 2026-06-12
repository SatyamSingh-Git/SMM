-- Cross-platform lineage: a duplicated draft points back at the original post.
ALTER TABLE "Post" ADD COLUMN "sourcePostId" TEXT;

ALTER TABLE "Post"
  ADD CONSTRAINT "Post_sourcePostId_fkey"
  FOREIGN KEY ("sourcePostId") REFERENCES "Post"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Post_sourcePostId_idx" ON "Post"("sourcePostId");
