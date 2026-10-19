// Fix 1b follow-up: the home page's "Nd left" chip (daysUntil) used raw
// Date.parse, so a bare-date micro row read a day short each evening even
// after the tile COUNT was fixed. It now routes through parseDeadlineMs —
// the same single definition everything else uses.
//
// The at-any-hour property holds by arithmetic: with bare dates parsed as
// end-of-day local, a notice due today has (0, 24h] remaining at EVERY hour
// of today, so ceil() gives 1 all day; due tomorrow gives (24h, 48h] -> 2
// all day. Whatever hour CI runs, these equalities pin that stability —
// under the old parse the same values flipped at 8pm Eastern.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { daysUntil } from "../app/page";

const pad = (n: number) => String(n).padStart(2, "0");
const bareLocal = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe("home deadline chip (daysUntil)", () => {
  it("a bare date due TODAY reads 1 day at any hour of today", () => {
    assert.equal(daysUntil(bareLocal(0)), 1);
  });

  it("a bare date due TOMORROW reads 2 days at any hour of today — never 0/negative in the evening", () => {
    assert.equal(daysUntil(bareLocal(1)), 2);
  });

  it("a bare date for YESTERDAY reads elapsed", () => {
    const d = daysUntil(bareLocal(-1));
    assert.ok(d != null && d <= 0, `expected <= 0, got ${d}`);
  });

  it("an ISO-timestamp deadline is unchanged from the old Date.parse behaviour", () => {
    // 36h out: ceil(1.5) = 2 under both parses — and the parse itself is
    // byte-identical for timestamped values (pinned in pipeline-summary tests).
    const iso = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString();
    assert.equal(daysUntil(iso), Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
  });

  it("garbage returns null, never a 1970-flavoured number", () => {
    assert.equal(daysUntil("not-a-date"), null);
    assert.equal(daysUntil(""), null);
  });
});
