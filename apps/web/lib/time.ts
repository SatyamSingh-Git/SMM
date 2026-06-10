// IST-first time helpers. The whole account operates in IST (Asia/Kolkata),
// so every timestamp the user sees should be unambiguous about it.

const IST_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const IST_TIME_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

// "Sat, 7 Jun, 8:30 PM" — full IST stamp.
export function renderIst(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return IST_FMT.format(date) + " IST";
}

// "8:30 PM IST" — time only.
export function renderIstTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return IST_TIME_FMT.format(date) + " IST";
}

const DOW_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Compute the next Date (in local time, for the datetime-local input) that
// falls on the given IST day-of-week (0=Mon) at the given IST hour. Used for
// the data-driven "best time" schedule chips.
export function nextIstSlot(dayOfWeek0Mon: number, hourIst: number): Date {
  // Work in IST by shifting now into IST wall-clock, finding the target, then
  // converting that IST wall-clock back to a real instant.
  const IST_OFFSET_MIN = 5 * 60 + 30;
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  // istNow is a Date whose UTC fields represent IST wall-clock.
  const istDow = (istNow.getUTCDay() + 6) % 7; // 0 = Mon
  let dayDelta = (dayOfWeek0Mon - istDow + 7) % 7;
  // Build the candidate IST wall-clock time.
  const candidate = new Date(istNow);
  candidate.setUTCDate(candidate.getUTCDate() + dayDelta);
  candidate.setUTCHours(hourIst, 0, 0, 0);
  // If it's today-in-IST but the hour already passed, jump a week.
  if (dayDelta === 0 && candidate.getTime() <= istNow.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  // Convert IST wall-clock back to a real UTC instant.
  return new Date(candidate.getTime() - IST_OFFSET_MIN * 60_000);
}

export function slotLabel(dayOfWeek0Mon: number, hourIst: number): string {
  const am = hourIst < 12;
  const h12 = hourIst % 12 === 0 ? 12 : hourIst % 12;
  return `${DOW_LABEL[dayOfWeek0Mon]} ${h12} ${am ? "AM" : "PM"}`;
}
