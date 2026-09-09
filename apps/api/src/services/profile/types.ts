// The shape of a Profile. Validated with zod on WRITE only — a malformed
// profile must be rejected at PATCH time, never discovered by a worker
// halfway through generating a reply.

import { z } from "zod";

// Placeholders a voice block may reference. Anything else is a typo and is
// rejected at write time rather than silently rendering as literal
// "{{hadnle}}" into a prompt sent to Meta.
export const IDENTITY_VARS = [
  "handle",
  "displayName",
  "pronouns",
  "ageBand",
  "nationality",
  "locale",
  "languages",
  "niche",
  "audience",
] as const;
export type IdentityVar = (typeof IDENTITY_VARS)[number];

export const IdentitySchema = z.object({
  /** Platform handle without the leading "@". */
  handle: z.string().min(1).max(60),
  displayName: z.string().max(120).default(""),
  /** Free text, not an enum — "she/her", "they/them", "he/him", anything. */
  pronouns: z.string().max(40).default(""),
  /** e.g. "19-21". A band, not a birthday: prompts read better with a range. */
  ageBand: z.string().max(40).default(""),
  nationality: z.string().max(60).default(""),
  /** IETF-ish region tag, used for copy and later for locale-aware formatting. */
  locale: z.string().max(20).default(""),
  languages: z.array(z.string().min(1).max(40)).max(10).default([]),
  niche: z.string().max(300).default(""),
  audience: z.string().max(300).default(""),
});
export type Identity = z.infer<typeof IdentitySchema>;

// Each voice block is the system prompt for one task, stored as prose with
// {{placeholders}}. Kept as prose rather than atomised into fields because a
// persona's voice IS prose — and because splitting the forbidden-word lists
// out into structured fields while the prose still contains them would create
// two sources of truth for the same rule. Extraction can come later, once the
// blocks have stopped moving.
export const VOICE_TASKS = [
  "caption",
  "reply",
  "dashboardStrategist",
  "dashboardCaptionAnalyst",
  "dashboardCommentAnalyst",
] as const;
export type VoiceTask = (typeof VOICE_TASKS)[number];

const block = z.string().min(1).max(20_000);

export const VoiceSchema = z.object({
  caption: block,
  reply: block,
  dashboardStrategist: block,
  dashboardCaptionAnalyst: block,
  dashboardCommentAnalyst: block,
});
export type Voice = z.infer<typeof VoiceSchema>;

export const VisualSchema = z.object({
  /**
   * The subject descriptor reproduced verbatim at the head of every generated
   * image prompt. Image models lock identity on exact-token repetition, which
   * is why the mechanism ("reproduce this verbatim") lives in the template and
   * only the descriptor itself lives here.
   */
  subjectDescriptor: z.string().max(8_000).default(""),
});
export type Visual = z.infer<typeof VisualSchema>;

// A quiet window in LOCAL wall-clock hours. `endH` may exceed 24 to express a
// window crossing midnight: {23, 30} is 23:00 today until 06:00 tomorrow, kept
// as one window rather than two so the overnight sleep is a single interval.
export const QuietWindowSchema = z
  .object({
    startH: z.number().min(0).max(47),
    endH: z.number().min(0).max(47),
  })
  .refine((w) => w.endH > w.startH, {
    message: "quiet window must end after it starts (use endH > 24 to cross midnight)",
  });
export type QuietWindow = z.infer<typeof QuietWindowSchema>;

// An active session, in minutes from local midnight. Dynamic sleep windows are
// placed inside these; how many and how long stays in AppSettings, because
// those are knobs you tune weekly rather than facts about the account.
export const SessionBandSchema = z
  .object({
    startMin: z.number().int().min(0).max(1440),
    endMin: z.number().int().min(0).max(1440),
  })
  .refine((b) => b.endMin > b.startMin, { message: "session must end after it starts" });
export type SessionBand = z.infer<typeof SessionBandSchema>;

export const CadenceSchema = z.object({
  /** IANA zone. Everything the scheduler does resolves through this. */
  timezone: z.string().max(60).default("Asia/Kolkata"),
  quietWindows: z.array(QuietWindowSchema).max(12).default([]),
  morningSession: SessionBandSchema,
  eveningSession: SessionBandSchema,
});
export type Cadence = z.infer<typeof CadenceSchema>;

/**
 * Reproduces the constants the scheduler used to hardcode, exactly. Used both
 * as the seed and as the fallback when no profile is loaded.
 *
 * Unlike voice, cadence fails OPEN. Replying on a sensible default schedule is
 * harmless; replying in a default VOICE is not. See profile/resolver.ts.
 */
export const DEFAULT_CADENCE: Cadence = {
  timezone: "Asia/Kolkata",
  quietWindows: [
    { startH: 23, endH: 30 }, // 23:00 -> 06:00 next day
    { startH: 11, endH: 12 },
    { startH: 14, endH: 16 },
  ],
  morningSession: { startMin: 6 * 60, endMin: 11 * 60 },
  eveningSession: { startMin: 16 * 60, endMin: 24 * 60 },
};

/**
 * Safety rail, deliberately NOT configurable: a schedule with no quiet time is
 * a bot pattern, and the human-cadence defence is the main thing protecting an
 * irreplaceable account. Preferences live in config; rails live in code.
 */
export const MIN_QUIET_HOURS_PER_DAY = 6;

/** Total hours covered by the quiet windows, treating overlaps once. */
export function quietHoursPerDay(windows: QuietWindow[]): number {
  const spans = windows
    .map((w) => [w.startH, w.endH] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) {
      total += end - from;
      cursor = end;
    }
  }
  return total;
}

export const AUTONOMY_LEVELS = ["off", "suggest", "review", "auto"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const AUTONOMY_STAGES = [
  "plan",
  "generate_media",
  "write_caption",
  "schedule",
  "publish",
  "reply",
  "learn",
] as const;
export type AutonomyStage = (typeof AUTONOMY_STAGES)[number];

export const PolicySchema = z.object({
  autonomy: z
    .record(z.enum(AUTONOMY_STAGES), z.enum(AUTONOMY_LEVELS))
    .default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export const ProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
  identity: IdentitySchema,
  voice: VoiceSchema,
  visual: VisualSchema,
  cadence: CadenceSchema,
  policy: PolicySchema,
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Every {{placeholder}} used in a string, in order of appearance. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
}

/**
 * Placeholders that are not known identity variables. Non-empty means the
 * profile would render a literal "{{typo}}" into a live prompt.
 */
export function unknownPlaceholders(voice: Voice): string[] {
  const known = new Set<string>(IDENTITY_VARS);
  const bad = new Set<string>();
  for (const text of Object.values(voice)) {
    for (const p of placeholdersIn(text)) if (!known.has(p)) bad.add(p);
  }
  return [...bad];
}
