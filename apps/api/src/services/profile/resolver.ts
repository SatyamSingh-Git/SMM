// Profile resolver — the fail-CLOSED counterpart to runtime-config.
//
// runtime-config deliberately fails OPEN: before its first DB read it hands
// back defaults, because a default reply cap is harmless and blocking the
// worker on boot would be worse.
//
// Profile data is the opposite case. If the persona is config and this fell
// back to a default, a worker tick during the ~200ms boot window would
// generate a reply in the WRONG VOICE and publish it to a real account. There
// is no undo on a published reply. So getProfile() returns null until the row
// is genuinely loaded, and every caller skips rather than guesses: a skipped
// reply is recoverable, a wrong-voice published one is not.

import { prisma } from "@smm/db";
import {
  CadenceSchema,
  IdentitySchema,
  PolicySchema,
  VisualSchema,
  VoiceSchema,
  type Profile,
} from "./types.js";

let cached: Profile | null = null;

/**
 * The active profile, or null if it has not loaded yet. NEVER falls back to a
 * default — see the note above. Synchronous so hot paths can call it without
 * an await.
 */
export function getProfile(): Profile | null {
  return cached;
}

/** Parse a DB row into a validated Profile. Throws on a malformed row. */
export function parseProfileRow(row: {
  id: string;
  name: string;
  version: number;
  identityJson: unknown;
  voiceJson: unknown;
  visualJson: unknown;
  cadenceJson: unknown;
  policyJson: unknown;
}): Profile {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    identity: IdentitySchema.parse(row.identityJson),
    voice: VoiceSchema.parse(row.voiceJson),
    visual: VisualSchema.parse(row.visualJson),
    cadence: CadenceSchema.parse(row.cadenceJson),
    policy: PolicySchema.parse(row.policyJson),
  };
}

/**
 * Create the default row from the seed if it does not exist yet. Idempotent:
 * an existing row is never overwritten, so a redeploy cannot clobber an edited
 * voice with the factory default.
 */
export async function ensureProfileSeeded(): Promise<void> {
  const existing = await prisma.profile.findUnique({ where: { id: "default" } });
  if (existing) return;
  // Imported lazily to break a cycle: seed.ts reads the constants out of ai.ts
  // and reply-generator.ts, and those now import the composer, which imports
  // this module. Seeding runs once at boot and is already async, so deferring
  // the import costs nothing.
  const { seedProfile } = await import("./seed.js");
  const p = seedProfile();
  await prisma.profile.create({
    data: {
      id: p.id,
      name: p.name,
      version: 1,
      identityJson: p.identity,
      voiceJson: p.voice,
      visualJson: p.visual,
      cadenceJson: p.cadence,
      policyJson: p.policy,
    },
  });
  console.log("[profile] seeded default profile from built-in constants");
}

/** Reload the row into the cache. Leaves the last good value on failure. */
export async function refreshProfile(): Promise<void> {
  try {
    const row = await prisma.profile.findUnique({ where: { id: "default" } });
    if (!row) {
      // Not an error on a cold database — ensureProfileSeeded runs on boot.
      // Staying null is the correct fail-closed behaviour meanwhile.
      return;
    }
    cached = parseProfileRow(row);
  } catch (e) {
    // A malformed row must not take down the worker, but it MUST NOT silently
    // become a default either. The cache keeps its last good value, or stays
    // null and callers keep skipping.
    console.error("[profile] refresh failed:", (e as Error).message);
  }
}

let started = false;
/** Prime the cache and start the periodic refresh. Idempotent. */
export function startProfile(): void {
  if (started) return;
  started = true;
  void (async () => {
    try {
      await ensureProfileSeeded();
    } catch (e) {
      console.error("[profile] seed failed:", (e as Error).message);
    }
    await refreshProfile();
  })();
  const t = setInterval(() => {
    void refreshProfile();
  }, 30_000);
  t.unref();
}

/**
 * The active profile, or throw. For request-driven paths where the user is
 * waiting and a clear error beats silence. NEVER use this on the reply path —
 * see getProfile().
 */
export function requireProfile(): Profile {
  const p = cached;
  if (!p) {
    throw new Error(
      "profile not loaded yet — the config cache primes a moment after boot; retry"
    );
  }
  return p;
}

/** Test seam. */
export function __setProfileForTests(p: Profile | null): void {
  cached = p;
}
