import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  localDateKey,
  localDatePlus,
  localDayStartUtcMs,
  localMinutesOfDay,
  offsetMinutesAt,
  zonedTimeToUtcMs,
} from "./tz.js";

const IST = "Asia/Kolkata";
const NY = "America/New_York";

describe("offsetMinutesAt", () => {
  it("handles a half-hour offset", () => {
    expect(offsetMinutesAt(Date.UTC(2026, 5, 15), IST)).toBe(330);
  });

  it("is stable year-round for a zone with no DST", () => {
    expect(offsetMinutesAt(Date.UTC(2026, 0, 15), IST)).toBe(330);
    expect(offsetMinutesAt(Date.UTC(2026, 6, 15), IST)).toBe(330);
  });

  it("tracks DST for a zone that observes it", () => {
    expect(offsetMinutesAt(Date.UTC(2026, 0, 15), NY)).toBe(-300); // EST
    expect(offsetMinutesAt(Date.UTC(2026, 6, 15), NY)).toBe(-240); // EDT
  });

  it("handles UTC itself", () => {
    expect(offsetMinutesAt(Date.UTC(2026, 5, 15), "UTC")).toBe(0);
  });
});

describe("zonedTimeToUtcMs", () => {
  it("resolves a local wall-clock time in a fixed-offset zone", () => {
    // 08:30 IST on 2026-06-15 is 03:00 UTC.
    expect(zonedTimeToUtcMs(2026, 6, 15, 8, 30, IST)).toBe(Date.UTC(2026, 5, 15, 3, 0));
  });

  it("round-trips with localParts", () => {
    const ms = zonedTimeToUtcMs(2026, 6, 15, 16, 45, NY);
    expect(localMinutesOfDay(ms, NY)).toBe(16 * 60 + 45);
    expect(localDateKey(ms, NY)).toBe("2026-06-15");
  });

  it("overflows the hour into the next local day", () => {
    // Hour 30 = 06:00 tomorrow. This is how the overnight quiet window is
    // expressed (23:00 -> 30:00).
    const overflowed = zonedTimeToUtcMs(2026, 6, 15, 30, 0, IST);
    expect(localDateKey(overflowed, IST)).toBe("2026-06-16");
    expect(localMinutesOfDay(overflowed, IST)).toBe(6 * 60);
  });

  it("overflows the day into the next month", () => {
    const ms = zonedTimeToUtcMs(2026, 6, 31, 12, 0, IST);
    expect(localDateKey(ms, IST)).toBe("2026-07-01");
  });
});

// The scheduler used to subtract a fixed offset. These are the cases that
// breaks: on a 23-hour day "midnight + 960 minutes" is not 16:00 local.
describe("DST transitions", () => {
  // US DST 2026: forward Sun 8 Mar, back Sun 1 Nov.
  const SPRING = { y: 2026, m: 3, d: 8 };
  const FALL = { y: 2026, m: 11, d: 1 };

  it("a spring-forward local day is 23 hours long", () => {
    const start = zonedTimeToUtcMs(SPRING.y, SPRING.m, SPRING.d, 0, 0, NY);
    const next = zonedTimeToUtcMs(SPRING.y, SPRING.m, SPRING.d + 1, 0, 0, NY);
    expect((next - start) / 3_600_000).toBe(23);
  });

  it("a fall-back local day is 25 hours long", () => {
    const start = zonedTimeToUtcMs(FALL.y, FALL.m, FALL.d, 0, 0, NY);
    const next = zonedTimeToUtcMs(FALL.y, FALL.m, FALL.d + 1, 0, 0, NY);
    expect((next - start) / 3_600_000).toBe(25);
  });

  // The whole point: every local wall-clock time on a transition day still
  // resolves to an instant that reads back as that same wall-clock time.
  it("every hour of a spring-forward day round-trips, except the missing one", () => {
    for (let hour = 0; hour < 24; hour++) {
      if (hour === 2) continue; // 02:00-03:00 does not exist locally
      const ms = zonedTimeToUtcMs(SPRING.y, SPRING.m, SPRING.d, hour, 0, NY);
      expect(localMinutesOfDay(ms, NY), `hour ${hour}`).toBe(hour * 60);
    }
  });

  it("every hour of a fall-back day round-trips", () => {
    for (let hour = 0; hour < 24; hour++) {
      const ms = zonedTimeToUtcMs(FALL.y, FALL.m, FALL.d, hour, 0, NY);
      expect(localMinutesOfDay(ms, NY), `hour ${hour}`).toBe(hour * 60);
    }
  });

  // A nonexistent local time must resolve to something sane rather than throw
  // — the reply worker cannot die once a year on a calendar quirk.
  // 02:00-03:00 does not exist on this date. What matters is that it resolves
  // deterministically, finitely, and within an hour of what was asked for —
  // not which side of the gap it lands on. It lands just before.
  it("resolves a nonexistent spring-gap time to just before the gap", () => {
    const ms = zonedTimeToUtcMs(SPRING.y, SPRING.m, SPRING.d, 2, 30, NY);
    expect(Number.isFinite(ms)).toBe(true);
    expect(localMinutesOfDay(ms, NY)).toBe(60 + 30);
    expect(zonedTimeToUtcMs(SPRING.y, SPRING.m, SPRING.d, 2, 30, NY)).toBe(ms);
  });

  it("resolves an ambiguous fall-back time to the first occurrence", () => {
    const ms = zonedTimeToUtcMs(FALL.y, FALL.m, FALL.d, 1, 30, NY);
    expect(offsetMinutesAt(ms, NY)).toBe(-240); // still EDT, the earlier one
    expect(localMinutesOfDay(ms, NY)).toBe(90);
  });

  it("keeps local midnight at midnight across both transitions", () => {
    for (const t of [SPRING, FALL]) {
      const ms = zonedTimeToUtcMs(t.y, t.m, t.d, 0, 0, NY);
      expect(localMinutesOfDay(ms, NY)).toBe(0);
      expect(localDayStartUtcMs(ms + 6 * 3_600_000, NY)).toBe(ms);
    }
  });
});

describe("localDateKey", () => {
  it("rolls over at local midnight, not UTC midnight", () => {
    // 18:29 UTC is 23:59 IST the same day; 18:30 UTC is 00:00 the next.
    expect(localDateKey(Date.UTC(2026, 5, 14, 18, 29), IST)).toBe("2026-06-14");
    expect(localDateKey(Date.UTC(2026, 5, 14, 18, 30), IST)).toBe("2026-06-15");
  });

  it("gives a different day for the same instant in different zones", () => {
    const instant = Date.UTC(2026, 5, 14, 20, 0);
    expect(localDateKey(instant, IST)).toBe("2026-06-15");
    expect(localDateKey(instant, NY)).toBe("2026-06-14");
  });
});

describe("localDatePlus", () => {
  it("shifts calendar days, not fixed 24h blocks", () => {
    // Across the spring-forward boundary a +1 day shift must still land on the
    // next calendar date even though only 23 hours elapsed.
    const onTransition = zonedTimeToUtcMs(2026, 3, 8, 12, 0, NY);
    expect(localDatePlus(onTransition, 1, NY)).toEqual({ year: 2026, month: 3, day: 9 });
    expect(localDatePlus(onTransition, -1, NY)).toEqual({ year: 2026, month: 3, day: 7 });
  });

  it("crosses month and year boundaries", () => {
    const ms = zonedTimeToUtcMs(2026, 12, 31, 12, 0, IST);
    expect(localDatePlus(ms, 1, IST)).toEqual({ year: 2027, month: 1, day: 1 });
  });
});

describe("isValidTimeZone", () => {
  it.each(["Asia/Kolkata", "America/New_York", "UTC", "Europe/London"])(
    "accepts %s",
    (tz) => expect(isValidTimeZone(tz)).toBe(true)
  );

  it.each(["Mars/Olympus", "not a zone", ""])("rejects %s", (tz) =>
    expect(isValidTimeZone(tz)).toBe(false)
  );
});
