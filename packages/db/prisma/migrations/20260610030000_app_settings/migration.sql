-- Single-row runtime configuration editable from the Settings UI.
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "dailyReplyCap" INTEGER NOT NULL DEFAULT 200,
    "perPostReplyCap" INTEGER NOT NULL DEFAULT 60,
    "morningSleepCount" INTEGER NOT NULL DEFAULT 2,
    "morningSleepMin" INTEGER NOT NULL DEFAULT 30,
    "eveningSleepCount" INTEGER NOT NULL DEFAULT 4,
    "eveningSleepMin" INTEGER NOT NULL DEFAULT 38,
    "deepseekModel" TEXT,
    "visionModel" TEXT,
    "deepseekApiKeyEnc" TEXT,
    "openrouterApiKeyEnc" TEXT,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row so the app always has defaults to read.
INSERT INTO "AppSettings" ("id", "updatedAt") VALUES ('singleton', NOW());
