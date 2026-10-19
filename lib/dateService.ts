// Canonical date/weekday math for GovScout (Item 1.1).
//
// WHY THIS EXISTS: the 2026-06-05 Day-4 scan claimed "6/6 is Friday" when it is
// actually Saturday — a near-miss on the NPD/OELA LEA-partner gate. Root cause:
// `new Date("2026-06-06")` parses as UTC midnight, then `.getDay()` /
// `.toLocaleDateString()` render that instant in the HOST timezone. On any host
// west of UTC (America/New_York is UTC-4/-5), UTC-midnight rolls back to the
// previous calendar day, so the weekday comes out one short.
//
// THE RULE: every scan, watcher, report, and view does day-of-week / weekday /
// calendar-day math through THIS module. Do not call `.getDay()` or
// `.toLocaleDateString()` for weekday logic anywhere else. All computation is
// timezone-anchored (default America/New_York) and DST-correct because it routes
// through Intl.DateTimeFormat with an explicit `timeZone`.

export const DEFAULT_TZ = "America/New_York";

export type DateInput = Date | string | number;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize any supported input to a Date instant.
 *
 * Date-only strings (`YYYY-MM-DD`) are anchored to **noon UTC** rather than the
 * spec default of midnight UTC. Noon UTC lands on the same calendar date in
 * every real-world timezone (UTC-12..UTC+14), so the wall-clock date the caller
 * typed is preserved no matter where the weekday is later rendered. Full
 * timestamps and epoch numbers pass through unchanged (they already carry an
 * unambiguous instant). Cron-injected ISO strings flow through here too.
 */
export function toInstant(input: DateInput): Date {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new Error("dateService: invalid Date");
    return input;
  }
  if (typeof input === "number") {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error(`dateService: invalid epoch ${input}`);
    return d;
  }
  const s = input.trim();
  if (DATE_ONLY.test(s)) return new Date(`${s}T12:00:00Z`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`dateService: unparseable date ${JSON.stringify(input)}`);
  }
  return d;
}

function partsInTz(input: DateInput, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(toInstant(input))) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

/** Full weekday name (e.g. "Saturday") for the given instant in `tz`. */
export function weekdayOf(input: DateInput, tz: string = DEFAULT_TZ): Weekday {
  return partsInTz(input, tz).weekday as Weekday;
}

/** 0=Sunday .. 6=Saturday, computed in `tz`. */
export function weekdayIndexOf(input: DateInput, tz: string = DEFAULT_TZ): number {
  return WEEKDAYS.indexOf(weekdayOf(input, tz));
}

/** True for Saturday/Sunday in `tz`. */
export function isWeekend(input: DateInput, tz: string = DEFAULT_TZ): boolean {
  const i = weekdayIndexOf(input, tz);
  return i === 0 || i === 6;
}

/** Calendar day key `YYYY-MM-DD` as seen in `tz` (DST-correct). */
export function dayKey(input: DateInput, tz: string = DEFAULT_TZ): string {
  const p = partsInTz(input, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Whole calendar days from `a` to `b` as seen in `tz` (b - a). Same day = 0,
 * next day = 1, yesterday = -1. Uses calendar dates, so DST transitions and
 * end-of-month boundaries never produce fractional or off-by-one drift.
 */
export function calendarDaysBetween(
  a: DateInput,
  b: DateInput,
  tz: string = DEFAULT_TZ,
): number {
  const ka = new Date(`${dayKey(a, tz)}T00:00:00Z`).getTime();
  const kb = new Date(`${dayKey(b, tz)}T00:00:00Z`).getTime();
  return Math.round((kb - ka) / 86_400_000);
}

/**
 * Age of `input` in days relative to `now` (default = real now), as a float.
 * For "is this older than N days" staleness checks (watchers, SAM freshness).
 */
export function ageInDays(input: DateInput, now: DateInput = Date.now()): number {
  return (toInstant(now).getTime() - toInstant(input).getTime()) / 86_400_000;
}

/** Human display, timezone-anchored. Thin wrapper over Intl for views/reports. */
export function formatInTz(
  input: DateInput,
  tz: string = DEFAULT_TZ,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts }).format(toInstant(input));
}

/** Current day key in `tz` — the canonical "today" for scans/reports. */
export function todayKey(tz: string = DEFAULT_TZ): string {
  return dayKey(Date.now(), tz);
}
