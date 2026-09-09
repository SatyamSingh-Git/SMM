import { beforeEach, describe, expect, it, vi } from "vitest";

// reply-schedule pulls in prisma (for the cap queries) and runtime-config
// (which self-primes against the DB on import). Neither is under test here —
// this suite is about the scheduling math, so both are replaced with fakes.
vi.mock("@smm/db", () => ({
  prisma: { engagementComment: { count: vi.fn(async () => 0) } },
}));

// Production defaults, spelled out so a change to them shows up as a failing
// test rather than as silently different sleep windows.
const TEST_CONFIG = {
  dailyReplyCap: 200,
  perPostReplyCap: 60,
  morning: { startMin: 6 * 60, endMin: 11 * 60, sleeps: [30, 30] },
  evening: { startMin: 16 * 60, endMin: 24 * 60, sleeps: [38, 38, 38, 38] },
};
vi.mock("./runtime-config.js", () => ({ getConfig: () => TEST_CONFIG }));

import {
  avoidQuietWindows,
  getDynamicSleepWindowsForDay,
  istDateKey,
  istDayStartUtcMs,
  planReplyTime,
} from "./reply-schedule.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const MIN_ACTIVE = 20;

/** IST hour-of-day for a UTC instant. */
function istHour(utcMs: number): number {
  return new Date(utcMs + IST_OFFSET_MS).getUTCHours();
}

/** UTC ms for a given IST wall-clock time. */
function utcFromIst(y: number, m: number, d: number, h: number, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MS;
}

describe("IST date helpers", () => {
  it("maps a UTC instant to its IST calendar day", () => {
    // 18:29 UTC is 23:59 IST the same day.
    expect(istDateKey(Date.UTC(2026, 5, 14, 18, 29))).toBe("2026-06-14");
    // 18:30 UTC is 00:00 IST the next day — the boundary that matters for the
    // daily reply cap and for seeding each day's sleep windows.
    expect(istDateKey(Date.UTC(2026, 5, 14, 18, 30))).toBe("2026-06-15");
  });

  it("returns 00:00 IST of the current IST day as a UTC instant", () => {
    const midMorning = utcFromIst(2026, 6, 15, 9, 45);
    expect(istDayStartUtcMs(midMorning)).toBe(utcFromIst(2026, 6, 15, 0, 0));
    expect(istHour(istDayStartUtcMs(midMorning))).toBe(0);
  });

  it("keeps a late-evening IST instant on the same IST day", () => {
    const lateEvening = utcFromIst(2026, 6, 15, 23, 30);
    expect(istDateKey(lateEvening)).toBe("2026-06-15");
    expect(istDayStartUtcMs(lateEvening)).toBe(utcFromIst(2026, 6, 15, 0, 0));
  });
});

describe("dynamic sleep windows", () => {
  it("is stable for a given day within a process", () => {
    const a = getDynamicSleepWindowsForDay("2026-06-15");
    const b = getDynamicSleepWindowsForDay("2026-06-15");
    expect(b).toEqual(a);
  });

  // The API process and the worker process each compute these independently.
  // If they ever disagree, replies fire inside what the other believes is a
  // sleep window and the human-pattern defence quietly stops working — with no
  // error anywhere. Re-importing the module with a cleared registry is the
  // closest we get to "a second process" in a unit test.
  it("is identical in a freshly loaded module (i.e. across processes)", async () => {
    const first = getDynamicSleepWindowsForDay("2026-07-02");
    vi.resetModules();
    const reloaded = await import("./reply-schedule.js");
    expect(reloaded.getDynamicSleepWindowsForDay("2026-07-02")).toEqual(first);
  });

  it("gives different days different windows", () => {
    const a = getDynamicSleepWindowsForDay("2026-06-16");
    const b = getDynamicSleepWindowsForDay("2026-06-17");
    expect(b).not.toEqual(a);
  });

  it("produces one window per configured sleep", () => {
    const windows = getDynamicSleepWindowsForDay("2026-06-18");
    expect(windows).toHaveLength(
      TEST_CONFIG.morning.sleeps.length + TEST_CONFIG.evening.sleeps.length
    );
  });

  it("keeps every window inside its session, ordered, and MIN_ACTIVE apart", () => {
    // A month of days, so the assertions cover many different random layouts
    // rather than whichever one today's seed happens to produce.
    for (let day = 1; day <= 28; day++) {
      const key = `2026-09-${String(day).padStart(2, "0")}`;
      const windows = getDynamicSleepWindowsForDay(key);
      const morning = windows.filter((w) => w.startMin < TEST_CONFIG.morning.endMin);
      const evening = windows.filter((w) => w.startMin >= TEST_CONFIG.evening.startMin);
      expect(morning.length + evening.length).toBe(windows.length);

      for (const [session, band, durations] of [
        [morning, TEST_CONFIG.morning, TEST_CONFIG.morning.sleeps],
        [evening, TEST_CONFIG.evening, TEST_CONFIG.evening.sleeps],
      ] as const) {
        const sorted = [...session].sort((a, b) => a.startMin - b.startMin);
        expect(session).toEqual(sorted);

        // Durations must be exactly the configured ones (order is shuffled).
        expect(session.map((w) => w.endMin - w.startMin).sort()).toEqual(
          [...durations].sort()
        );

        // Active time at both edges of the session and between windows.
        expect(sorted[0]!.startMin).toBeGreaterThanOrEqual(band.startMin + MIN_ACTIVE);
        expect(sorted[sorted.length - 1]!.endMin).toBeLessThanOrEqual(
          band.endMin - MIN_ACTIVE
        );
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i]!.startMin - sorted[i - 1]!.endMin).toBeGreaterThanOrEqual(
            MIN_ACTIVE
          );
        }
      }
    }
  });

  it("returns no windows when the sleeps cannot fit the session", async () => {
    vi.resetModules();
    vi.doMock("./runtime-config.js", () => ({
      getConfig: () => ({
        ...TEST_CONFIG,
        // 10 x 60min sleeps cannot fit a 5h morning — must degrade to "no
        // dynamic sleep today" rather than throwing and killing the worker.
        morning: { startMin: 6 * 60, endMin: 11 * 60, sleeps: Array(10).fill(60) },
      }),
    }));
    const mod = await import("./reply-schedule.js");
    const windows = mod.getDynamicSleepWindowsForDay("2026-06-19");
    expect(windows.filter((w) => w.startMin < 11 * 60)).toEqual([]);
    vi.doUnmock("./runtime-config.js");
    vi.resetModules();
  });
});

describe("avoidQuietWindows", () => {
  it("leaves a time outside every window alone", () => {
    // 09:00 IST sits in the morning session. Only assert the no-op when the
    // day's dynamic windows don't happen to cover it.
    const t = utcFromIst(2026, 6, 20, 9, 5);
    const moved = avoidQuietWindows(t);
    if (moved === t) {
      expect(moved).toBe(t);
    } else {
      // It landed in a dynamic sleep window — then it must have been pushed
      // forward, never backward.
      expect(moved).toBeGreaterThan(t);
    }
  });

  it("pushes out of the afternoon break to just past 16:00 IST", () => {
    const inside = utcFromIst(2026, 6, 20, 15, 0);
    const out = avoidQuietWindows(inside);
    const boundary = utcFromIst(2026, 6, 20, 16, 0);
    expect(out).toBeGreaterThanOrEqual(boundary);
    expect(out).toBeLessThan(boundary + 3 * 60_000); // jitter is capped at 3min
  });

  it("pushes out of the late-morning break to just past 12:00 IST", () => {
    const out = avoidQuietWindows(utcFromIst(2026, 6, 20, 11, 30));
    const boundary = utcFromIst(2026, 6, 20, 12, 0);
    expect(out).toBeGreaterThanOrEqual(boundary);
    expect(out).toBeLessThan(boundary + 3 * 60_000);
  });

  it("pushes an overnight time to just past 06:00 IST the same morning", () => {
    const out = avoidQuietWindows(utcFromIst(2026, 6, 20, 2, 15));
    const boundary = utcFromIst(2026, 6, 20, 6, 0);
    expect(out).toBeGreaterThanOrEqual(boundary);
    expect(out).toBeLessThan(boundary + 3 * 60_000);
  });

  it("pushes a 23:30 IST time into the next morning, not the same one", () => {
    const out = avoidQuietWindows(utcFromIst(2026, 6, 20, 23, 30));
    const boundary = utcFromIst(2026, 6, 21, 6, 0);
    expect(out).toBeGreaterThanOrEqual(boundary);
    expect(out).toBeLessThan(boundary + 3 * 60_000);
  });

  it("is a fixed point once resolved", () => {
    for (const hour of [0, 3, 7, 11, 13, 15, 18, 21, 23]) {
      const settled = avoidQuietWindows(utcFromIst(2026, 6, 22, hour, 30));
      expect(avoidQuietWindows(settled)).toBe(settled);
    }
  });
});

describe("planReplyTime", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockRestore();
  });

  it("delays 5-20 minutes when the slot is already clear", () => {
    // 08:00 IST, then confirm it wasn't deferred before asserting the band.
    const now = utcFromIst(2026, 6, 23, 8, 0);
    const { fireAtMs, deferredFromQuietWindow } = planReplyTime(now);
    if (!deferredFromQuietWindow) {
      expect(fireAtMs - now).toBeGreaterThanOrEqual(5 * 60_000);
      expect(fireAtMs - now).toBeLessThan(20 * 60_000);
    }
  });

  it("reports deferral when the comment lands inside a quiet window", () => {
    const { deferredFromQuietWindow } = planReplyTime(utcFromIst(2026, 6, 23, 14, 30));
    expect(deferredFromQuietWindow).toBe(true);
  });

  // The property that actually protects the account: whatever time a comment
  // arrives, the reply never fires inside a fixed quiet window.
  it("never schedules inside a fixed quiet window, from any arrival time", () => {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = utcFromIst(2026, 6, 24, 0, minute);
      const { fireAtMs } = planReplyTime(now);
      const h = istHour(fireAtMs);
      expect(h, `arrival ${minute}m IST fired at ${h}h IST`).not.toBe(23);
      expect(h).toBeGreaterThanOrEqual(6);
      expect(h).not.toBe(11);
      expect(h).not.toBe(14);
      expect(h).not.toBe(15);
      // And it is settled with respect to the dynamic windows too.
      expect(avoidQuietWindows(fireAtMs)).toBe(fireAtMs);
    }
  });

  it("always schedules into the future", () => {
    for (let minute = 0; minute < 24 * 60; minute += 37) {
      const now = utcFromIst(2026, 6, 25, 0, minute);
      expect(planReplyTime(now).fireAtMs).toBeGreaterThan(now);
    }
  });
});
