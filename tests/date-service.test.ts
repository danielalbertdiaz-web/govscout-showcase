// Tests for the canonical dateService (Item 1.1).
//
// The load-bearing regression is the 2026-06-05 Day-4 scan that rendered
// "6/6 is Friday" when 2026-06-06 is a Saturday. Everything else here guards
// the timezone-anchoring invariants the module promises: DST flips, UTC
// timestamps that cross local midnight, end-of-month spans, and bad input.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  toInstant,
  weekdayOf,
  weekdayIndexOf,
  isWeekend,
  dayKey,
  calendarDaysBetween,
  ageInDays,
  formatInTz,
  todayKey,
  DEFAULT_TZ,
} from "../lib/dateService";

test("THE regression: 6/6 is Saturday, 6/5 is Friday (date-only strings)", () => {
  assert.equal(weekdayOf("2026-06-06"), "Saturday");
  assert.equal(weekdayOf("2026-06-05"), "Friday");
});

test("weekday indices: 0=Sunday .. 6=Saturday", () => {
  assert.equal(weekdayIndexOf("2026-06-07"), 0); // Sunday
  assert.equal(weekdayIndexOf("2026-06-08"), 1); // Monday
  assert.equal(weekdayIndexOf("2026-06-06"), 6); // Saturday
});

test("isWeekend flags Saturday and Sunday only", () => {
  assert.equal(isWeekend("2026-06-06"), true); // Sat
  assert.equal(isWeekend("2026-06-07"), true); // Sun
  assert.equal(isWeekend("2026-06-05"), false); // Fri
  assert.equal(isWeekend("2026-06-08"), false); // Mon
});

test("DST spring-forward: 2026-03-08 is a Sunday in EDT transition", () => {
  // Clocks jump 02:00->03:00 EST->EDT on 2026-03-08. Weekday math must hold.
  assert.equal(weekdayOf("2026-03-08"), "Sunday");
  // A timestamp during the gap still resolves to the right NY calendar day.
  assert.equal(dayKey("2026-03-08T07:30:00Z"), "2026-03-08"); // 02:30 EST -> 03:30 EDT
});

test("DST fall-back: 2026-11-01 is a Sunday (EDT->EST)", () => {
  assert.equal(weekdayOf("2026-11-01"), "Sunday");
  assert.equal(dayKey("2026-11-01T05:30:00Z"), "2026-11-01"); // 01:30 local, ambiguous hour
});

test("UTC timestamp crossing local midnight stays on the local calendar day", () => {
  // 02:00Z on 6/6 is 22:00 EDT on 6/5 in New York -> still Friday.
  assert.equal(dayKey("2026-06-06T02:00:00Z"), "2026-06-05");
  assert.equal(weekdayOf("2026-06-06T02:00:00Z"), "Friday");
  // But noon Z lands squarely on 6/6 everywhere.
  assert.equal(dayKey("2026-06-06T12:00:00Z"), "2026-06-06");
});

test("calendarDaysBetween across end-of-month and DST", () => {
  assert.equal(calendarDaysBetween("2026-01-31", "2026-02-01"), 1);
  assert.equal(calendarDaysBetween("2026-02-28", "2026-03-01"), 1); // 2026 not a leap year
  assert.equal(calendarDaysBetween("2026-06-06", "2026-06-06"), 0);
  assert.equal(calendarDaysBetween("2026-06-06", "2026-06-05"), -1);
  // Spanning the spring-forward day must still be whole calendar days.
  assert.equal(calendarDaysBetween("2026-03-07", "2026-03-09"), 2);
});

test("toInstant accepts Date, epoch number, full ISO, and date-only", () => {
  assert.ok(toInstant(new Date()) instanceof Date);
  assert.equal(toInstant("2026-06-06").toISOString(), "2026-06-06T12:00:00.000Z");
  assert.equal(toInstant(0).toISOString(), "1970-01-01T00:00:00.000Z");
  assert.equal(weekdayIndexOf(1749211200000), weekdayIndexOf(new Date(1749211200000)));
});

test("ageInDays measures staleness relative to now", () => {
  const now = "2026-06-10T12:00:00Z";
  assert.equal(Math.round(ageInDays("2026-06-05T12:00:00Z", now)), 5);
  assert.ok(ageInDays("2026-06-11T12:00:00Z", now) < 0); // future = negative age
});

test("formatInTz and todayKey are timezone-anchored", () => {
  assert.equal(formatInTz("2026-06-06", DEFAULT_TZ, { dateStyle: "medium" }), "Jun 6, 2026");
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test("garbage input throws rather than silently drifting", () => {
  assert.throws(() => toInstant("not-a-date"));
  assert.throws(() => toInstant(Number.NaN));
  assert.throws(() => toInstant(new Date("nope")));
});
