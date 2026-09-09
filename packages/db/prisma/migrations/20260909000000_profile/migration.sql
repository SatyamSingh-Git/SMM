-- The Profile: everything about WHO the account is, moved out of code.
-- Seeded by the API on boot (services/profile/seed.ts) from the constants that
-- used to be hardcoded, so behaviour is identical until someone edits it.
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL DEFAULT 'Default',
    "identityJson" JSONB NOT NULL,
    "voiceJson" JSONB NOT NULL,
    "visualJson" JSONB NOT NULL,
    "cadenceJson" JSONB NOT NULL,
    "policyJson" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- Immutable history so a voice edit that degrades replies can be diffed and
-- rolled back.
CREATE TABLE "ProfileVersion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProfileVersion_profileId_version_key" ON "ProfileVersion"("profileId", "version");
CREATE INDEX "ProfileVersion_profileId_createdAt_idx" ON "ProfileVersion"("profileId", "createdAt");

ALTER TABLE "ProfileVersion" ADD CONSTRAINT "ProfileVersion_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
