// Micro-sweep -> GovScout canonical routing (V4.1 §14.6).
//
// The sweep cron triaged 295 SAM notices into CSV while micro_contracts held
// 0 rows — "a high-stakes automation appearing integrated while writing to
// untracked CSV/status files only". These cover the pure parse/map layer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitCsvLine,
  parseSweepCsv,
  mapDisposition,
  mapRows,
  dedupeByNotice,
} from "../lib/micro-sweep-import";

describe("csv splitting", () => {
  it("handles quoted fields containing commas", () => {
    // Real sweep titles routinely contain commas.
    assert.deepEqual(splitCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
  });

  it("handles escaped quotes", () => {
    assert.deepEqual(splitCsvLine('a,"say ""hi""",b'), ["a", 'say "hi"', "b"]);
  });

  it("preserves empty trailing fields", () => {
    assert.deepEqual(splitCsvLine("a,,"), ["a", "", ""]);
  });
});

const HEADER = "noticeId,solicitationNumber,title,agency,naics,responseDeadline,disposition";

describe("sweep csv parsing", () => {
  it("parses the real PROCESSED.csv shape", () => {
    const csv = [
      HEADER,
      "932f2be8,N61331-26-Q-KS45,Community Outreach & Recruiting,DEPT OF DEFENSE,512110,2026-07-27,video-production-cmmc-level1-required",
    ].join("\n");
    const rows = parseSweepCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].noticeId, "932f2be8");
    assert.equal(rows[0].solicitationNumber, "N61331-26-Q-KS45");
    assert.equal(rows[0].naics, "512110");
    assert.equal(rows[0].rawDisposition, "video-production-cmmc-level1-required");
  });

  it("treats blank optional fields as null, not empty string", () => {
    const rows = parseSweepCsv([HEADER, "abc,,Some title,,,,killed-title-keyword"].join("\n"));
    assert.equal(rows[0].solicitationNumber, null);
    assert.equal(rows[0].agency, null);
    assert.equal(rows[0].responseDeadline, null);
  });

  it("skips rows with no notice id", () => {
    assert.equal(parseSweepCsv([HEADER, ",,,,,,killed-x"].join("\n")).length, 0);
  });

  it("returns nothing for an empty or headerless file", () => {
    assert.deepEqual(parseSweepCsv(""), []);
    assert.deepEqual(parseSweepCsv("garbage\n"), []);
  });
});

describe("disposition mapping", () => {
  it("maps killed- verdicts to passed and keeps the reason", () => {
    const m = mapDisposition("killed-naics:561621");
    assert.equal(m.disposition, "passed");
    assert.equal(m.killReason, "killed-naics:561621");
  });

  it("maps foreign place-of-performance to passed", () => {
    assert.equal(mapDisposition("foreign-pop-nepal-kathmandu").disposition, "passed");
  });

  it("honours a verdict already in the vocabulary", () => {
    assert.equal(mapDisposition("won").disposition, "won");
    assert.equal(mapDisposition("won").killReason, null);
  });

  it("sends an unrecognised verdict to new, never to a silent pass", () => {
    // The sweep emits descriptive slugs like "welder-training-divers-physical"
    // that read as disqualifiers but are not in GovScout's vocabulary. Guessing
    // would fabricate a decision the system cannot justify, so a human looks.
    const m = mapDisposition("welder-training-divers-physical");
    assert.equal(m.disposition, "new");
    assert.notEqual(m.disposition, "passed");
  });

  it("treats an empty verdict as new", () => {
    assert.equal(mapDisposition("").disposition, "new");
    assert.equal(mapDisposition("   ").disposition, "new");
  });
});

describe("dedupe", () => {
  it("keeps one row per notice, last write winning", () => {
    const rows = mapRows([
      { noticeId: "a", solicitationNumber: null, title: "first", agency: null, naics: null, responseDeadline: null, rawDisposition: "" },
      { noticeId: "a", solicitationNumber: null, title: "second", agency: null, naics: null, responseDeadline: null, rawDisposition: "killed-x" },
      { noticeId: "b", solicitationNumber: null, title: "other", agency: null, naics: null, responseDeadline: null, rawDisposition: "" },
    ]);
    const out = dedupeByNotice(rows);
    assert.equal(out.length, 2);
    assert.equal(out.find((r) => r.noticeId === "a")?.title, "second");
  });
});
