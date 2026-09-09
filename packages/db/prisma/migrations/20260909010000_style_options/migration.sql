-- Visual taxonomy as data. Seeded by the API on boot from the constants that
-- used to live in services/image-prompts.ts.
CREATE TABLE "StyleOption" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "conflictsWith" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "StyleOption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StyleOption_profileId_dimension_key_key" ON "StyleOption"("profileId", "dimension", "key");
CREATE INDEX "StyleOption_profileId_dimension_enabled_idx" ON "StyleOption"("profileId", "dimension", "enabled");
