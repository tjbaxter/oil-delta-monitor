/**
 * CME Globex CL (WTI crude) market calendar.
 * Hardcoded for 2026 — update annually.
 *
 * Regular Globex hours for energy futures:
 *   Sunday 5:00 PM CT → Friday 4:00 PM CT
 *   Daily maintenance break: 4:00–5:00 PM CT every day
 *
 * CT offset: CDT (UTC−5) Mar 8 → Nov 1; CST (UTC−6) otherwise.
 */

export interface CMEStatus {
  isOpen: boolean;
  reason: string;
  reopens: string | null; // human-readable, e.g. "Sunday 10:00 PM UTC"
}

// ── DST helpers ────────────────────────────────────────────────────────────────

/** US DST: second Sunday of March through first Sunday of November */
function isDST(utcMs: number): boolean {
  const d = new Date(utcMs);
  const year = d.getUTCFullYear();

  // Second Sunday of March
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchFirstDow = marchFirst.getUTCDay();
  const dstStart = new Date(Date.UTC(year, 2, 1 + ((7 - marchFirstDow) % 7) + 7, 2)); // 2 AM CT

  // First Sunday of November
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstDow = novFirst.getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, 1 + ((7 - novFirstDow) % 7), 2)); // 2 AM CT

  return utcMs >= dstStart.getTime() && utcMs < dstEnd.getTime();
}

/** CT offset from UTC in hours: CDT = −5, CST = −6 */
function ctOffsetHours(utcMs: number): number {
  return isDST(utcMs) ? -5 : -6;
}

/** Get local CT date/time components from a UTC ms timestamp */
function toCT(utcMs: number): { year: number; month: number; day: number; dow: number; hourFrac: number } {
  const offset = ctOffsetHours(utcMs);
  const d = new Date(utcMs + offset * 3_600_000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1, // 1-based
    day: d.getUTCDate(),
    dow: d.getUTCDay(),          // 0 = Sunday
    hourFrac: d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  };
}

// ── 2026 holiday calendar ──────────────────────────────────────────────────────

interface HolidayEntry {
  month: number;
  day: number;
  reason: string;
  fullClose: boolean; // false = early close at 12:00 PM CT
}

const HOLIDAYS_2026: HolidayEntry[] = [
  { month: 1,  day: 1,  reason: "New Year's Day",        fullClose: true  },
  { month: 1,  day: 19, reason: "Martin Luther King Jr. Day", fullClose: false },
  { month: 2,  day: 16, reason: "Presidents' Day",        fullClose: false },
  { month: 4,  day: 3,  reason: "Good Friday",            fullClose: true  },
  { month: 5,  day: 25, reason: "Memorial Day",           fullClose: false },
  { month: 7,  day: 3,  reason: "Independence Day",       fullClose: false },
  { month: 9,  day: 7,  reason: "Labor Day",              fullClose: false },
  { month: 11, day: 26, reason: "Thanksgiving",           fullClose: false },
  { month: 11, day: 27, reason: "Thanksgiving Friday",    fullClose: false },
  { month: 12, day: 25, reason: "Christmas Day",          fullClose: true  },
];

function findHoliday(year: number, month: number, day: number): HolidayEntry | null {
  if (year !== 2026) return null;
  return HOLIDAYS_2026.find((h) => h.month === month && h.day === day) ?? null;
}

// ── Reopen strings ─────────────────────────────────────────────────────────────

function nextSundayReopens(utcMs: number): string {
  // Next Sunday 10:00 PM UTC (= 5 PM CDT / 5 PM CST adjusted)
  const d = new Date(utcMs);
  const dow = d.getUTCDay(); // 0 = Sun
  const daysUntilSunday = dow === 0 ? 7 : 7 - dow;
  const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilSunday));
  const offset = ctOffsetHours(sunday.getTime());
  const reopenUtcHour = 17 - offset; // 5 PM CT → UTC
  sunday.setUTCHours(reopenUtcHour, 0, 0, 0);
  return sunday.toUTCString().replace(" GMT", " UTC").slice(0, -4);
}

function tomorrowMaintEnd(utcMs: number): string {
  // 5 PM CT = end of maintenance window
  const d = new Date(utcMs);
  const offset = ctOffsetHours(utcMs);
  const endHour = 17 - offset; // 5 PM CT → UTC
  const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), endHour));
  if (candidate.getTime() <= utcMs) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return `${candidate.toISOString().slice(11, 16)} UTC`;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Returns the current CME Globex status for WTI crude (CL) futures.
 * Call with `new Date()` for the current status.
 */
export function getCMEStatus(now: Date = new Date()): CMEStatus {
  const utcMs = now.getTime();
  const ct = toCT(utcMs);
  const holiday = findHoliday(ct.year, ct.month, ct.day);

  // ── Full-close holidays ──────────────────────────────────────────────────
  if (holiday?.fullClose) {
    // Find the next trading day's Sunday open or Monday open
    const reopens = ct.dow <= 5
      ? nextSundayReopens(utcMs)
      : tomorrowMaintEnd(utcMs);
    return {
      isOpen: false,
      reason: `CME closed — ${holiday.reason}`,
      reopens
    };
  }

  // ── Early-close holidays: after 12:00 PM CT ───────────────────────────────
  if (holiday && !holiday.fullClose && ct.hourFrac >= 12.0) {
    return {
      isOpen: false,
      reason: `CME early close — ${holiday.reason}`,
      reopens: nextSundayReopens(utcMs)
    };
  }

  // ── Weekend: Friday after 4 PM CT through Sunday before 5 PM CT ──────────
  // dow 5 = Friday, dow 6 = Saturday, dow 0 = Sunday
  const isFridayAfterClose = ct.dow === 5 && ct.hourFrac >= 16.0;
  const isSaturday = ct.dow === 6;
  const isSundayBeforeOpen = ct.dow === 0 && ct.hourFrac < 17.0;

  if (isFridayAfterClose || isSaturday || isSundayBeforeOpen) {
    const offset = ctOffsetHours(utcMs);
    const utcHour = 17 - offset; // 5 PM CT → UTC
    // Find the upcoming Sunday
    const d = new Date(utcMs);
    const daysUntilSunday = ct.dow === 0 ? 0 : 7 - ct.dow;
    const sunday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilSunday, utcHour));
    const timeStr = `${String(utcHour).padStart(2, "0")}:00 UTC`;
    return {
      isOpen: false,
      reason: "CME closed — weekend",
      reopens: `Sunday at ${timeStr}`
    };
  }

  // ── Daily maintenance: 4:00–5:00 PM CT ───────────────────────────────────
  if (ct.hourFrac >= 16.0 && ct.hourFrac < 17.0) {
    return {
      isOpen: false,
      reason: "CME daily maintenance window (4–5 PM CT)",
      reopens: tomorrowMaintEnd(utcMs)
    };
  }

  return { isOpen: true, reason: "open", reopens: null };
}
