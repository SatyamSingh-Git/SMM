// Reply scheduling rules:
//   1. Wait 3-10 random minutes after the comment arrives (looks human, not bot)
//   2. Never fire inside these IST quiet windows:
//        00:00-06:00  (sleeping)
//        11:00-12:00
//        14:00-16:00
//      If the jittered fire-time falls inside a quiet window, push to the
//      end of that window + small random jitter.
//   3. Hard cap 300 replies per IST day. Past that, skip the comment.
//
// IST is UTC+5:30 fixed (no DST). All math goes through that offset.

import { prisma } from "@smm/db";

const IST_OFFSET_MIN = 5 * 60 + 30;

// Quiet windows — NO replies during these hours (IST).
const QUIET_WINDOWS_IST: Array<{ startH: number; endH: number }> = [
  { startH: 0, endH: 6 },
  { startH: 11, endH: 12 },
  { startH: 14, endH: 16 },
];

export const DAILY_REPLY_CAP = 300;

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

/**
 * Given a desired fire time (UTC ms), if it falls inside any IST quiet window,
 * push it to the end of that window + small random jitter so back-to-back
 * deferred replies don't all fire at the exact window boundary.
 *
 * Otherwise return the input unchanged.
 */
export function avoidQuietWindows(desiredFireMs: number): number {
  // Check today's, yesterday's (in case desired is just before 06:00 IST),
  // and tomorrow's windows to be safe.
  for (let dayOffset = -1; dayOffset <= 2; dayOffset++) {
    for (const w of QUIET_WINDOWS_IST) {
      const start = istHourToUtcMs(desiredFireMs, dayOffset, w.startH);
      const end = istHourToUtcMs(desiredFireMs, dayOffset, w.endH);
      if (desiredFireMs >= start && desiredFireMs < end) {
        // Inside a quiet window — push to the end + 0-3 min jitter so
        // multiple deferred replies stagger naturally.
        return end + Math.floor(Math.random() * 3 * 60_000);
      }
    }
  }
  return desiredFireMs;
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
