// Timezone math for a configurable IANA zone.
//
// The scheduler used to assume a fixed UTC+5:30 with an explicit "no DST"
// comment, and did its conversions by subtracting a constant. That is correct
// for Asia/Kolkata and wrong for every zone that observes DST, in ways that
// matter: a spring-forward day has 23 hours, so a sleep window computed as
// "day start + 960 minutes" lands an hour away from local 16:00, and a
// fall-back day repeats an hour, so the same local time maps to two instants.
//
// Everything here therefore resolves LOCAL WALL-CLOCK TIME to an absolute UTC
// instant using the zone's real offset on that date. Nothing subtracts a
// constant.

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23", // without this, midnight formats as "24" in some locales
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

export type LocalParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** Wall-clock parts in `timeZone` for a UTC instant. */
export function localParts(utcMs: number, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's UTC offset in minutes at a given instant (east positive). */
export function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second precision on both sides so the difference is a whole
  // number of minutes even for zones with historical second-level offsets.
  return Math.round((asIfUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/**
 * The UTC instant for a local wall-clock time. Hour and minute may overflow
 * (hour 30 means 06:00 the next day), which is how the overnight quiet window
 * is expressed.
 *
 * Two passes: guess with the offset at the naive instant, then re-resolve with
 * the offset actually in force at the result. That is what makes a boundary
 * sitting on either side of a DST transition land on the right instant.
 *
 * Edge cases, both deliberate and both verified in tz.test.ts:
 *   - a time inside a spring-forward gap does not exist locally, so it
 *     resolves to the instant one offset-step BEFORE the gap (02:30 on a US
 *     spring day reads back as 01:30)
 *   - an ambiguous fall-back time resolves to the FIRST occurrence
 *
 * Neither may throw: the reply worker must not die once a year on a calendar
 * quirk. Both land within an hour of the requested boundary, which is well
 * inside the tolerance of a sleep window that is already randomised by tens of
 * minutes. Every local time that DOES exist round-trips exactly, including
 * every other hour of both transition days.
 */
export function zonedTimeToUtcMs(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = naive - offsetMinutesAt(naive, timeZone) * 60_000;
  const corrected = naive - offsetMinutesAt(firstGuess, timeZone) * 60_000;
  return corrected;
}

/** "YYYY-MM-DD" for the local calendar day containing this instant. */
export function localDateKey(utcMs: number, timeZone: string): string {
  const p = localParts(utcMs, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Local calendar date, `dayOffset` days from the one containing `utcMs`. */
export function localDatePlus(
  utcMs: number,
  dayOffset: number,
  timeZone: string
): { year: number; month: number; day: number } {
  const p = localParts(utcMs, timeZone);
  // Date.UTC normalises overflow (day 32 -> the 1st of the next month), and
  // shifting whole calendar days here rather than adding 86_400_000 ms is what
  // keeps this correct across a DST transition.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** The UTC instant of local midnight for the day containing `utcMs`. */
export function localDayStartUtcMs(utcMs: number, timeZone: string): number {
  const d = localDatePlus(utcMs, 0, timeZone);
  return zonedTimeToUtcMs(d.year, d.month, d.day, 0, 0, timeZone);
}

/** Minutes since local midnight. Handles a DST day being 23 or 25 hours long. */
export function localMinutesOfDay(utcMs: number, timeZone: string): number {
  const p = localParts(utcMs, timeZone);
  return p.hour * 60 + p.minute;
}

/** True if the IANA zone name is one this runtime actually knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
