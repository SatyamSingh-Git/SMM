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
// The account's timezone, quiet windows and session bands all come from
// profile.cadence (services/profile/types.ts). Cadence fails OPEN to defaults
// that reproduce the old hardcoded constants — replying on a sensible default
// schedule is harmless, unlike replying in a default voice.
//
// Every local wall-clock boundary resolves to an absolute UTC instant through
// services/tz.ts, never by subtracting a fixed offset. That is what keeps the
// schedule correct in a DST zone, where a local day can be 23 or 25 hours long
// and "local midnight + 960 minutes" is not 16:00.

import { prisma } from "@smm/db";
import { getConfig } from "./runtime-config.js";
import { getCadence } from "./profile/resolver.js";
import { localDateKey, localDatePlus, zonedTimeToUtcMs } from "./tz.js";

// Minimum active time between sleeps (and at session edges) so two sleeps
// don't merge into one long break. A rail, not a preference.
const MIN_ACTIVE_SEGMENT_MIN = 20;

/**
 * The UTC instant of a local wall-clock time, `dayOffset` days from the local
 * day containing `referenceMs`. `hour` may exceed 24 — the overnight quiet
 * window is expressed as 23 -> 30.
 */
function zonedHourToUtcMs(
  referenceMs: number,
  dayOffset: number,
  hour: number,
  minute = 0
): number {
  const tz = getCadence().timezone;
  const d = localDatePlus(referenceMs, dayOffset, tz);
  return zonedTimeToUtcMs(d.year, d.month, d.day, hour, minute, tz);
}

/** "YYYY-MM-DD" for the account's local day containing this instant. */
export function accountDateKey(utcMs: number): string {
  return localDateKey(utcMs, getCadence().timezone);
}

export function accountDayStartUtcMs(utcMs: number): number {
  return zonedHourToUtcMs(utcMs, 0, 0);
}

// ---------- Deterministic per-day dynamic sleep windows ----------

// The local date key for (referenceMs + dayOffset days). Used by
// dynamicWindowsForDay to seed the PRNG so each local day gets stable windows.
// Shifts by CALENDAR days rather than adding 86_400_000ms, which is what keeps
// it correct across a DST transition.
function dateKeyWithOffset(referenceMs: number, dayOffset: number): string {
  const d = localDatePlus(referenceMs, dayOffset, getCadence().timezone);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
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

// Memoize each day's computed windows so a mid-day config change does NOT shift
// an already-active sleep schedule — today stays as first computed; new config
// naturally applies tomorrow (a new dateKey). Bounded to a few recent days.
const windowMemo = new Map<string, Array<{ startMin: number; endMin: number }>>();

/**
 * Returns the dynamic sleep windows in minutes-of-IST-day for the given IST date
 * key (e.g. "2026-05-30"). Deterministic given (date + current config), and
 * memoized per day so it's stable within a day even if config changes.
 */
export function getDynamicSleepWindowsForDay(
  dateKey: string
): Array<{ startMin: number; endMin: number }> {
  const memoed = windowMemo.get(dateKey);
  if (memoed) return memoed;

  const cfg = getConfig();
  const cadence = getCadence();
  // Per-session RNG seeds (instead of a shared rng walked in fixed order) so the
  // evening windows are independent of whether morning happened to be feasible.
  const morningRng = mulberry32(hashSeed(dateKey + ":morning"));
  const eveningRng = mulberry32(hashSeed(dateKey + ":evening"));
  // Bands are profile config; how many sleeps and how long they run stay in
  // AppSettings, because those are weekly tuning knobs rather than facts about
  // the account.
  const morning = pickSleepWindowsInSession(
    cadence.morningSession,
    cfg.morning.sleeps,
    morningRng
  );
  const evening = pickSleepWindowsInSession(
    cadence.eveningSession,
    cfg.evening.sleeps,
    eveningRng
  );
  const windows = [...morning, ...evening];

  windowMemo.set(dateKey, windows);
  // FIFO eviction of OLD days only — never evict a day we're still in. Only
  // ~4 day keys are ever live (yesterday..day-after, from avoidQuietWindows'
  // -1..+2 offset scan), so today is never dropped mid-day. This is what makes
  // a mid-day config edit unable to reshuffle the current day's frozen schedule.
  if (windowMemo.size > 6) {
    const oldest = windowMemo.keys().next().value;
    if (oldest !== undefined) windowMemo.delete(oldest);
  }
  return windows;
}

/** Pretty-print today's dynamic sleep windows as "HH:MM-HH:MM, ..." (local). */
export function formatDynamicSleepWindowsToday(): string {
  const todayKey = accountDateKey(Date.now());
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
  for (const w of getCadence().quietWindows) {
    out.push({
      startMs: zonedHourToUtcMs(referenceMs, dayOffset, w.startH),
      endMs: zonedHourToUtcMs(referenceMs, dayOffset, w.endH),
    });
  }
  return out;
}

function dynamicWindowsForDay(referenceMs: number, dayOffset: number): AbsWindow[] {
  const dateKey = dateKeyWithOffset(referenceMs, dayOffset);
  const windows = getDynamicSleepWindowsForDay(dateKey);
  // Each boundary resolves as a LOCAL WALL-CLOCK time on that local date, not
  // as "local midnight + N minutes". On a DST day those differ by an hour, and
  // the difference is a reply firing inside what should be a sleep window.
  return windows.map((w) => ({
    startMs: zonedHourToUtcMs(
      referenceMs,
      dayOffset,
      Math.floor(w.startMin / 60),
      w.startMin % 60
    ),
    endMs: zonedHourToUtcMs(
      referenceMs,
      dayOffset,
      Math.floor(w.endMin / 60),
      w.endMin % 60
    ),
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
 * Count replies committed for today (account-local). Counts queued + replying + replied
 * so we never overshoot the cap with in-flight comments.
 *
 * excludeCommentId: at SEND time the comment being processed is already flipped
 * to "replying", so it's inside this count. Pass its id to exclude it — then the
 * check measures OTHER committed replies and the comparison stays an exact
 * "< cap" boundary (otherwise the in-flight comment double-counts itself and we
 * lose one reply at the exact cap).
 */
export async function todaysReplyCount(excludeCommentId?: string): Promise<number> {
  const dayStart = new Date(accountDayStartUtcMs(Date.now()));
  return prisma.engagementComment.count({
    where: {
      receivedAt: { gte: dayStart },
      status: { in: ["queued", "replying", "replied"] },
      ...(excludeCommentId ? { id: { not: excludeCommentId } } : {}),
    },
  });
}

export async function isOverDailyCap(excludeCommentId?: string): Promise<boolean> {
  const n = await todaysReplyCount(excludeCommentId);
  return n >= getConfig().dailyReplyCap;
}

/**
 * Count committed replies for ONE post today (account-local). Same semantics as
 * todaysReplyCount but scoped to a single platformPostId. See excludeCommentId
 * note above.
 */
export async function postReplyCountToday(
  platformPostId: string,
  excludeCommentId?: string
): Promise<number> {
  const dayStart = new Date(accountDayStartUtcMs(Date.now()));
  return prisma.engagementComment.count({
    where: {
      platformPostId,
      receivedAt: { gte: dayStart },
      status: { in: ["queued", "replying", "replied"] },
      ...(excludeCommentId ? { id: { not: excludeCommentId } } : {}),
    },
  });
}

export async function isOverPerPostCap(
  platformPostId: string,
  excludeCommentId?: string
): Promise<boolean> {
  const n = await postReplyCountToday(platformPostId, excludeCommentId);
  return n >= getConfig().perPostReplyCap;
}
