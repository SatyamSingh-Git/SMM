// Reply scheduling rules:
//   1. Wait 5-20 random minutes after the comment arrives (looks human, not bot)
//   2. Never fire inside these FIXED IST quiet windows:
//        00:00-06:00  (overnight)
//        11:00-12:00
//        14:00-16:00
//   3. PLUS daily-random DYNAMIC sleep windows inside each active session:
//        Morning  (06:00-11:00): 2 × 30-min sleeps   (1.0h extra sleep)
//        Evening  (16:00-24:00): 2 × 30-min + 2 × 45-min sleeps (2.5h extra)
//      Dynamic windows are DETERMINED FROM THE IST DATE via a seeded PRNG, so
//      they're stable across worker restarts and identical for every check on
//      the same day. Every day's windows are different.
//   4. If a desired fire-time lands inside ANY quiet window (fixed or dynamic),
//      push to the end of that window + small random jitter. The pusher
//      re-checks in a loop in case the pushed time lands in an adjacent window.
//   5. Hard cap 300 replies per IST day. Past that, skip the comment.
//
// IST is UTC+5:30 fixed (no DST). All math goes through that offset.

import { prisma } from "@smm/db";

const IST_OFFSET_MIN = 5 * 60 + 30;

// Quiet windows — NO replies during these hours (IST).
// The overnight window crosses midnight: 23:00 IST today → 06:00 IST tomorrow.
// Encoded as a single entry with endH = 30 (24 + 6); Date.UTC normalizes the
// overflow into the next calendar day cleanly, so a single window covers the
// whole 7-hour overnight sleep without splitting.
const QUIET_WINDOWS_IST: Array<{ startH: number; endH: number }> = [
  { startH: 23, endH: 30 },     // 23:00 IST today → 06:00 IST tomorrow (7h overnight)
  { startH: 11, endH: 12 },     // 11-12 IST (1h late-morning break)
  { startH: 14, endH: 16 },     // 14-16 IST (2h afternoon break)
];

// Active sessions for dynamic sleep windows (in minutes of the IST day).
const MORNING_SESSION = { startMin: 6 * 60, endMin: 11 * 60 };       // 06:00 - 11:00
const EVENING_SESSION = { startMin: 16 * 60, endMin: 24 * 60 };      // 16:00 - 24:00
// Sleep window durations (minutes) the PRNG places randomly inside each session.
const MORNING_SLEEPS_MIN = [30, 30];                                 // 1.0h total
const EVENING_SLEEPS_MIN = [30, 30, 45, 45];                         // 2.5h total
// Minimum active time between sleeps (and at session edges) so two sleeps
// don't merge into one long break.
const MIN_ACTIVE_SEGMENT_MIN = 20;

export const DAILY_REPLY_CAP = 200;

function toIstDate(utcMs: number): Date {
  return new Date(utcMs + IST_OFFSET_MIN * 60_000);
}

/** Given a reference UTC ms instant + day offset + IST hour, return matching UTC ms. */
function istHourToUtcMs(referenceMs: number, dayOffset: number, hour: number): number {
  const ist = toIstDate(referenceMs);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate() + dayOffset;
  return Date.UTC(y, m, d, hour, 0, 0) - IST_OFFSET_MIN * 60_000;
}

export function istDateKey(utcMs: number): string {
  const d = toIstDate(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function istDayStartUtcMs(utcMs: number): number {
  return istHourToUtcMs(utcMs, 0, 0);
}

// ---------- Deterministic per-day dynamic sleep windows ----------

// Compute the IST date key for (referenceMs + dayOffset days). Used by
// dynamicWindowsForDay to seed the PRNG so each IST day gets stable windows.
function istDateKeyWithOffset(referenceMs: number, dayOffset: number): string {
  const istMs = referenceMs + IST_OFFSET_MIN * 60_000 + dayOffset * 86400_000;
  const d = new Date(istMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// FNV-1a-ish 32-bit hash. Stable + good distribution for date-string seeds.
function hashSeed(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — small, fast, well-distributed PRNG. Returns a function that
// yields uniform [0,1) values. Deterministic given the seed.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Place N sleep windows inside a session with at least MIN_ACTIVE_SEGMENT_MIN
// of active time before, between, and after each. The total active slack is
// split into N+1 random pieces via N random cut points sorted ascending — a
// uniform sample over the simplex of N+1 non-negative pieces summing to slack.
// Deterministic given `rng`. Window durations are shuffled per day so the
// 30/45-min mix lands in different orders.
function pickSleepWindowsInSession(
  session: { startMin: number; endMin: number },
  durations: number[],
  rng: () => number
): Array<{ startMin: number; endMin: number }> {
  const n = durations.length;
  if (n === 0) return [];
  const sessionLen = session.endMin - session.startMin;
  const totalSleep = durations.reduce((a, b) => a + b, 0);
  const segments = n + 1;
  const minRequired = totalSleep + segments * MIN_ACTIVE_SEGMENT_MIN;
  // Fail safe: if the session can't fit, return no windows (better than
  // throwing — the runner still works, just without dynamic sleep this day).
  if (sessionLen < minRequired) return [];
  const slack = sessionLen - totalSleep - segments * MIN_ACTIVE_SEGMENT_MIN;

  // Shuffle durations (Fisher-Yates) so 30/45 mix order varies per day.
  const shuffled = durations.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }

  // Pick (segments - 1) random cut points in [0, slack] and sort ascending.
  // The differences between consecutive cuts (and the endpoints 0 and slack)
  // give us `segments` non-negative pieces of slack.
  const cuts: number[] = [];
  for (let i = 0; i < segments - 1; i++) {
    cuts.push(Math.floor(rng() * (slack + 1)));
  }
  cuts.sort((a, b) => a - b);

  const slackPieces: number[] = [];
  let prev = 0;
  for (const c of cuts) {
    slackPieces.push(c - prev);
    prev = c;
  }
  slackPieces.push(slack - prev);

  // Walk the timeline: active = MIN + slackPiece, then sleep window.
  // Last slack piece tails the final sleep — no window object needed for it.
  const windows: Array<{ startMin: number; endMin: number }> = [];
  let cursor = session.startMin;
  for (let i = 0; i < shuffled.length; i++) {
    cursor += MIN_ACTIVE_SEGMENT_MIN + slackPieces[i]!;
    const start = cursor;
    const end = start + shuffled[i]!;
    windows.push({ startMin: start, endMin: end });
    cursor = end;
  }
  return windows;
}

/**
 * Returns the (deterministic) dynamic sleep windows in minutes-of-IST-day for
 * the given IST date key (e.g. "2026-05-30"). Same date → same windows, always.
 * Different date → different windows.
 */
export function getDynamicSleepWindowsForDay(
  dateKey: string
): Array<{ startMin: number; endMin: number }> {
  // Per-session RNG seeds (instead of a shared rng walked in fixed order).
  // This makes the evening windows independent of whether morning happened
  // to be feasible — so if someone tweaks MORNING_SLEEPS_MIN to be too large
  // for the session in the future, the evening windows don't silently shift.
  const morningRng = mulberry32(hashSeed(dateKey + ":morning"));
  const eveningRng = mulberry32(hashSeed(dateKey + ":evening"));
  const morning = pickSleepWindowsInSession(MORNING_SESSION, MORNING_SLEEPS_MIN, morningRng);
  const evening = pickSleepWindowsInSession(EVENING_SESSION, EVENING_SLEEPS_MIN, eveningRng);
  return [...morning, ...evening];
}

/** Pretty-print today's dynamic sleep windows as "HH:MM-HH:MM, ..." (IST). */
export function formatDynamicSleepWindowsToday(): string {
  const todayKey = istDateKey(Date.now());
  const windows = getDynamicSleepWindowsForDay(todayKey);
  if (windows.length === 0) return "(none)";
  const pad = (n: number) => String(n).padStart(2, "0");
  return windows
    .map((w) => {
      // mod 24 in case a future config tunes the session to end exactly at
      // 24:00 — the bare hour would render as "24:00" otherwise. Production
      // params already keep us under 23:40 (MIN_ACTIVE buffer), but this is
      // a cheap defense.
      const sh = Math.floor(w.startMin / 60) % 24;
      const sm = w.startMin % 60;
      const eh = Math.floor(w.endMin / 60) % 24;
      const em = w.endMin % 60;
      return `${pad(sh)}:${pad(sm)}-${pad(eh)}:${pad(em)}`;
    })
    .join(", ");
}

// ---------- avoidQuietWindows (now considers static + dynamic windows) ----------

type AbsWindow = { startMs: number; endMs: number };

function staticWindowsForDay(referenceMs: number, dayOffset: number): AbsWindow[] {
  const out: AbsWindow[] = [];
  for (const w of QUIET_WINDOWS_IST) {
    out.push({
      startMs: istHourToUtcMs(referenceMs, dayOffset, w.startH),
      endMs: istHourToUtcMs(referenceMs, dayOffset, w.endH),
    });
  }
  return out;
}

function dynamicWindowsForDay(referenceMs: number, dayOffset: number): AbsWindow[] {
  const dateKey = istDateKeyWithOffset(referenceMs, dayOffset);
  const windows = getDynamicSleepWindowsForDay(dateKey);
  // 00:00 IST of the (referenceMs+dayOffset) IST day, in UTC ms.
  const dayStartUtcMs = istHourToUtcMs(referenceMs, dayOffset, 0);
  return windows.map((w) => ({
    startMs: dayStartUtcMs + w.startMin * 60_000,
    endMs: dayStartUtcMs + w.endMin * 60_000,
  }));
}

/**
 * Given a desired fire time (UTC ms), if it falls inside any IST quiet window
 * (fixed OR dynamic per-day), push it to the end of that window + small random
 * jitter so back-to-back deferred replies don't all fire at the exact boundary.
 * Re-checks in a loop in case the pushed time lands in an adjacent window.
 *
 * Returns the input unchanged if it's outside every window.
 */
export function avoidQuietWindows(desiredFireMs: number): number {
  let current = desiredFireMs;
  // Outer pass loop: re-check after every push. Static windows are spaced far
  // apart (≥4h gaps), but dynamic windows can sit close to static or each
  // other, so a single pass isn't enough in edge cases. 8 passes is plenty.
  for (let pass = 0; pass < 8; pass++) {
    let pushed = false;
    // Walk yesterday / today / tomorrow / day-after so we catch windows on
    // either side of the IST day boundary that the desired time might cross.
    for (let dayOffset = -1; dayOffset <= 2 && !pushed; dayOffset++) {
      const windows = [
        ...staticWindowsForDay(current, dayOffset),
        ...dynamicWindowsForDay(current, dayOffset),
      ];
      for (const w of windows) {
        if (current >= w.startMs && current < w.endMs) {
          current = w.endMs + Math.floor(Math.random() * 3 * 60_000);
          pushed = true;
          break;
        }
      }
    }
    if (!pushed) return current;
  }
  return current;
}

/**
 * Plan when a single reply should fire.
 *   - Adds 5-20 minutes of random delay (more human than instant)
 *   - Pushes past any IST quiet window the jittered time falls into
 */
export function planReplyTime(nowMs: number = Date.now()): {
  fireAtMs: number;
  deferredFromQuietWindow: boolean;
} {
  // 5 min base + 0-15 min random ⇒ window 5-20 min after the comment lands.
  const delayMs = 5 * 60_000 + Math.floor(Math.random() * 15 * 60_000);
  const desired = nowMs + delayMs;
  const fireAtMs = avoidQuietWindows(desired);
  return {
    fireAtMs,
    deferredFromQuietWindow: fireAtMs - desired > 60_000,
  };
}

/**
 * Count replies committed for today (IST). Counts queued + replying + replied
 * so we never overshoot the cap with in-flight comments.
 */
export async function todaysReplyCount(): Promise<number> {
  const dayStart = new Date(istDayStartUtcMs(Date.now()));
  return prisma.engagementComment.count({
    where: {
      receivedAt: { gte: dayStart },
      status: { in: ["queued", "replying", "replied"] },
    },
  });
}

export async function isOverDailyCap(): Promise<boolean> {
  const n = await todaysReplyCount();
  return n >= DAILY_REPLY_CAP;
}
