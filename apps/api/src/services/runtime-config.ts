// Runtime configuration resolver.
//
// A single AppSettings row holds every engagement/AI knob that used to be a
// hardcoded constant or an env var. This module loads that row, decrypts the
// API keys, layers env vars as fallbacks, and exposes a SYNCHRONOUS getConfig()
// for the hot paths (reply scheduler, AI clients).
//
// Safety design:
//   - getConfig() NEVER throws or blocks. Until the first DB load completes it
//     returns DEFAULTS — which exactly reproduce the old hardcoded behaviour —
//     so early-boot callers are safe.
//   - The cache refreshes on a 30s interval AND write-through after a PATCH, so
//     edits go live within seconds (instantly in the writing process).
//   - Each process that imports this module self-primes (the API process also
//     hosts the workers in prod; in dev they're separate and each primes).

import { prisma } from "@smm/db";
import { env } from "../env.js";
import { decryptToken } from "../crypto.js";

export type SessionConfig = {
  startMin: number;
  endMin: number;
  sleeps: number[]; // one entry per sleep window, value = duration in minutes
};

// Session time-bands are fixed by the system (not user-editable). Only the
// number of sleep windows + their duration inside each band are configurable.
const MORNING_BAND = { startMin: 6 * 60, endMin: 11 * 60 }; // 06:00-11:00 IST
const EVENING_BAND = { startMin: 16 * 60, endMin: 24 * 60 }; // 16:00-24:00 IST

export type ResolvedConfig = {
  dailyReplyCap: number;
  perPostReplyCap: number;
  morning: SessionConfig;
  evening: SessionConfig;
  deepseekModel: string;
  deepseekApiKey: string | null;
  visionModel: string;
  openrouterApiKey: string | null;
  killSwitch: boolean;
  autoReplyEnabled: boolean;
};

// Defaults reproduce the previous hardcoded constants exactly (and match the
// seeded AppSettings row), so behaviour is identical before the first DB read.
function buildDefaults(): ResolvedConfig {
  return {
    dailyReplyCap: 200,
    perPostReplyCap: 60,
    morning: { ...MORNING_BAND, sleeps: [30, 30] },
    evening: { ...EVENING_BAND, sleeps: [38, 38, 38, 38] },
    deepseekModel: env.DEEPSEEK_MODEL,
    deepseekApiKey: env.DEEPSEEK_API_KEY ?? null,
    visionModel: env.OPENROUTER_VISION_MODEL,
    openrouterApiKey: env.OPENROUTER_API_KEY ?? null,
    killSwitch: env.KILL_SWITCH,
    autoReplyEnabled: true,
  };
}

let cached: ResolvedConfig | null = null;

/** Synchronous, never-throws config accessor for hot paths. */
export function getConfig(): ResolvedConfig {
  return cached ?? buildDefaults();
}

function sessionFrom(
  band: { startMin: number; endMin: number },
  count: number,
  durMin: number
): SessionConfig {
  return {
    startMin: band.startMin,
    endMin: band.endMin,
    sleeps: Array.from({ length: Math.max(0, count) }, () => durMin),
  };
}

function safeDecrypt(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptToken(enc);
  } catch {
    // A bad/rotated key shouldn't take down config — fall back to env.
    return null;
  }
}

/** Reload the singleton row into the cache. Safe to call repeatedly. */
export async function refreshConfig(): Promise<void> {
  try {
    const row = await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton" },
      update: {},
    });
    const dbDeepseekKey = safeDecrypt(row.deepseekApiKeyEnc);
    const dbOpenrouterKey = safeDecrypt(row.openrouterApiKeyEnc);
    cached = {
      dailyReplyCap: row.dailyReplyCap,
      perPostReplyCap: row.perPostReplyCap,
      morning: sessionFrom(MORNING_BAND, row.morningSleepCount, row.morningSleepMin),
      evening: sessionFrom(EVENING_BAND, row.eveningSleepCount, row.eveningSleepMin),
      deepseekModel: row.deepseekModel?.trim() || env.DEEPSEEK_MODEL,
      deepseekApiKey: dbDeepseekKey || env.DEEPSEEK_API_KEY || null,
      visionModel: row.visionModel?.trim() || env.OPENROUTER_VISION_MODEL,
      openrouterApiKey: dbOpenrouterKey || env.OPENROUTER_API_KEY || null,
      // env KILL_SWITCH can still force-kill regardless of the DB toggle.
      killSwitch: row.killSwitch || env.KILL_SWITCH,
      autoReplyEnabled: row.autoReplyEnabled,
    };
  } catch (e) {
    // Keep the last good cache (or defaults) on a transient DB error.
    console.error("[runtime-config] refresh failed:", (e as Error).message);
  }
}

let started = false;
/** Prime the cache once and start the periodic refresh. Idempotent. */
export function startRuntimeConfig(): void {
  if (started) return;
  started = true;
  refreshConfig().catch(() => undefined);
  const t = setInterval(() => {
    refreshConfig().catch(() => undefined);
  }, 30_000);
  t.unref();
}

// Self-prime on import so any entrypoint (API, worker) gets a fresh cache
// without needing to remember to call startRuntimeConfig().
startRuntimeConfig();
