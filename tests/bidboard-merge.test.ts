// Bid Board -> GovScout split-brain merge — pure logic only, no database.
//
// The forked stores disagree on timestamp units (Bid Board: ISO text /
// epoch seconds; GovScout: epoch ms), so normalisation is per value, and
// conflict detection must never mistake a unit difference for real drift.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseEpoch,
  resolveStatus,
  diffRow,
  mapBidBoardRow,
  fromFpOpportunity,
  buildEnrichmentInput,
  buildImportInput,
  type MergeRow,
} from "../lib/bidboard-merge";
import type { FpOpportunity } from "../lib/federal-pipeline-types";

function makeRow(overrides: Partial<MergeRow> = {}): MergeRow {
  return {
    solNumber: "W912HZ-26-Q-0042",
    noticeId: "abc123",
    trackingNumber: null,
    title: "Test opportunity",
    agency: "DEPT OF DEFENSE",
    office: null,
    naics: "541511",
    setAside: null,
    noticeType: null,
    tier: "micro",
    source: "sam",
    url: null,
    responseDeadline: "2026-08-15T17:00:00-04:00",
    qaDeadline: null,
    popStart: null,
    popEnd: null,
    submissionMethod: null,
    submissionTarget: null,
    status: "discovered",
    nobidReason: null,
    aiDeliverabilityScore: null,
    priceQuoted: null,
    priceBasis: null,
    competitorsEst: null,
    poc1Name: null,
    poc1Email: null,
    poc1Phone: null,
    poc2Name: null,
    poc2Email: null,
    poc2Phone: null,
    draftPaths: [],
    gmailDraftId: null,
    gmailSentIds: [],
    resultAwardAmount: null,
    resultAwardee: null,
    resultNotes: null,
    createdAt: 1785000000000,
    updatedAt: 1785000000000,
    ...overrides,
  };
}

describe("normaliseEpoch", () => {
  it("returns a plausible ms value unchanged", () => {
    assert.equal(normaliseEpoch(1785512914263), 1785512914263);
  });

  it("converts an epoch-seconds value to ms", () => {
    assert.equal(normaliseEpoch(1785000000), 1785000000000);
  });

  it("returns null for 0 — unknown, not 1970", () => {
    assert.equal(normaliseEpoch(0), null);
  });

  it("returns null for null and undefined", () => {
    assert.equal(normaliseEpoch(null), null);
    assert.equal(normaliseEpoch(undefined), null);
  });

  it("returns null for tiny junk values instead of mapping them near 1970", () => {
    // Bid Board's max rendered as 1969-12-31 19:00:02 when read as ms — the
    // stored value was junk-small. Never resurrect those as 1970 dates.
    assert.equal(normaliseEpoch(2), null);
    assert.equal(normaliseEpoch(-5), null);
  });

  it("returns null for the ambiguous 1e11..1e12 band", () => {
    assert.equal(normaliseEpoch(5e11), null);
  });

  it("parses ISO-8601 strings (what Bid Board actually stores) to ms", () => {
    assert.equal(normaliseEpoch("2026-07-28T21:44:00.000Z"), Date.parse("2026-07-28T21:44:00.000Z"));
  });

  it("treats numeric strings by the same seconds/ms heuristic", () => {
    assert.equal(normaliseEpoch("1785000000"), 1785000000000);
    assert.equal(normaliseEpoch("1785512914263"), 1785512914263);
  });

  it("returns null for unparseable strings and non-scalar values", () => {
    assert.equal(normaliseEpoch("not a date"), null);
    assert.equal(normaliseEpoch(""), null);
    assert.equal(normaliseEpoch({}), null);
  });
});

describe("resolveStatus", () => {
  it("preserves a valid Bid Board status", () => {
    assert.equal(resolveStatus("submitted"), "submitted");
    assert.equal(resolveStatus("triaged_nobid"), "triaged_nobid");
  });

  it("falls back to discovered for unknown/invalid status", () => {
    assert.equal(resolveStatus("shipped"), "discovered");
    assert.equal(resolveStatus(""), "discovered");
    assert.equal(resolveStatus(null), "discovered");
    assert.equal(resolveStatus(undefined), "discovered");
  });
});

describe("diffRow", () => {
  it("produces no actions for identical rows", () => {
    const { enrich, conflicts } = diffRow(makeRow(), makeRow());
    assert.deepEqual(enrich, {});
    assert.deepEqual(conflicts, []);
  });

  it("enriches when bid board has a value and govscout is null", () => {
    const gs = makeRow({ agency: null, poc1Email: null });
    const bb = makeRow({ agency: "USACE", poc1Email: "ko@usace.example.org" });
    const { enrich, conflicts } = diffRow(gs, bb);
    assert.deepEqual(enrich, { agency: "USACE", poc1Email: "ko@usace.example.org" });
    assert.deepEqual(conflicts, []);
  });

  it("treats a govscout empty string as fillable, like null", () => {
    const gs = makeRow({ office: "  " });
    const bb = makeRow({ office: "Fort Worth District" });
    const { enrich } = diffRow(gs, bb);
    assert.deepEqual(enrich, { office: "Fort Worth District" });
  });

  it("records a conflict when both hold different non-empty values — never enrich", () => {
    const gs = makeRow({ priceQuoted: 18500 });
    const bb = makeRow({ priceQuoted: 24000 });
    const { enrich, conflicts } = diffRow(gs, bb);
    assert.deepEqual(enrich, {});
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, "priceQuoted");
    assert.equal(conflicts[0].govscout, 18500);
    assert.equal(conflicts[0].bidboard, 24000);
    assert.equal(conflicts[0].solNumber, "W912HZ-26-Q-0042");
  });

  it("never lets an empty bid board value overwrite a govscout value", () => {
    const gs = makeRow({ agency: "GSA" });
    const bb = makeRow({ agency: null });
    const { enrich, conflicts } = diffRow(gs, bb);
    assert.deepEqual(enrich, {});
    assert.deepEqual(conflicts, []);
  });

  it("flags a status divergence as a conflict, not an overwrite", () => {
    const gs = makeRow({ status: "discovered" });
    const bb = makeRow({ status: "submitted" });
    const { enrich, conflicts } = diffRow(gs, bb);
    assert.deepEqual(enrich, {});
    assert.deepEqual(
      conflicts.map((c) => c.field),
      ["status"],
    );
  });

  it("ignores fields that differ only by timestamp unit", () => {
    // Same instant, seconds vs ms: normalisation happens in the mappers, and
    // createdAt/updatedAt are bookkeeping — never enrichment, never conflict.
    const gs = makeRow({ createdAt: 1785000000000, updatedAt: 1785000000000 });
    const bb = mapBidBoardRow({
      sol_number: gs.solNumber,
      notice_id: gs.noticeId,
      title: gs.title,
      agency: gs.agency,
      naics: gs.naics,
      tier: "micro",
      source: "sam",
      response_deadline: gs.responseDeadline,
      status: "discovered",
      draft_paths: "[]",
      gmail_sent_ids: "[]",
      created_at: 1785000000, // seconds
      updated_at: 1785000000, // seconds
    });
    assert.equal(bb.createdAt, 1785000000000);
    const { enrich, conflicts } = diffRow(gs, bb);
    assert.deepEqual(enrich, {});
    assert.deepEqual(conflicts, []);
  });

  it("compares json-array fields by content", () => {
    const gs = makeRow({ draftPaths: ["a.docx"] });
    const same = makeRow({ draftPaths: ["a.docx"] });
    const diff = makeRow({ draftPaths: ["b.docx"] });
    assert.deepEqual(diffRow(gs, same).conflicts, []);
    assert.equal(diffRow(gs, diff).conflicts[0]?.field, "draftPaths");
  });

  it("compares competitors_est across the INTEGER/TEXT type drift", () => {
    // Bid Board stored INTEGER; GovScout stores TEXT. 3 maps to "3" = identical.
    const bb = mapBidBoardRow({ title: "x", competitors_est: 3 });
    const gs = makeRow({ competitorsEst: "3" });
    const { conflicts } = diffRow(gs, makeRow({ competitorsEst: bb.competitorsEst }));
    assert.deepEqual(conflicts, []);
  });
});

describe("mapBidBoardRow", () => {
  it("maps a raw snake_case row, normalising status/tier/arrays/timestamps", () => {
    const row = mapBidBoardRow({
      sol_number: " HT0038-26-SC-004 ",
      notice_id: "n1",
      title: "GLP-1 tech transfer",
      tier: "not-a-tier",
      source: "sam",
      status: "bogus-status",
      competitors_est: 4,
      draft_paths: '["drafts/a.docx"]',
      gmail_sent_ids: "not json",
      created_at: "2026-07-28T21:44:00.000Z",
      updated_at: 1785000000,
    });
    assert.equal(row.solNumber, "HT0038-26-SC-004");
    assert.equal(row.tier, null);
    assert.equal(row.status, "discovered");
    assert.equal(row.competitorsEst, "4");
    assert.deepEqual(row.draftPaths, ["drafts/a.docx"]);
    assert.deepEqual(row.gmailSentIds, []);
    assert.equal(row.createdAt, Date.parse("2026-07-28T21:44:00.000Z"));
    assert.equal(row.updatedAt, 1785000000000);
  });

  it("falls back to source 'other' for an unknown source", () => {
    assert.equal(mapBidBoardRow({ title: "x", source: "spreadsheet" }).source, "other");
  });
});

describe("fromFpOpportunity", () => {
  it("carries a govscout opportunity into the comparable shape", () => {
    const opp: FpOpportunity = {
      id: "uuid-1",
      clientId: "el",
      solNumber: "S-1",
      noticeId: "n-1",
      trackingNumber: null,
      title: "T",
      agency: null,
      description: null,
      reopenWatchAt: null,
      office: null,
      naics: null,
      setAside: null,
      noticeType: null,
      tier: null,
      source: "sam",
      url: null,
      responseDeadline: null,
      qaDeadline: null,
      popStart: null,
      popEnd: null,
      submissionMethod: null,
      submissionTarget: null,
      status: "submitted",
      nobidReason: null,
      aiDeliverabilityScore: null,
      scoreBasis: null,
      scaleSignals: [],
      priceQuoted: null,
      priceBasis: null,
      competitorsEst: null,
      poc1Name: null,
      poc1Email: null,
      poc1Phone: null,
      poc2Name: null,
      poc2Email: null,
      poc2Phone: null,
      draftPaths: [],
      gmailDraftId: null,
      gmailSentIds: [],
      resultAwardAmount: null,
      resultAwardee: null,
      resultNotes: null,
      flaggedAt: null,
      createdAt: 1785512914263,
      updatedAt: 1785512914263,
    };
    const row = fromFpOpportunity(opp);
    assert.equal(row.solNumber, "S-1");
    assert.equal(row.status, "submitted");
    assert.equal(row.updatedAt, 1785512914263);
  });
});

describe("buildEnrichmentInput", () => {
  it("includes only the enrichment fields plus keys and the existing title", () => {
    const gs = makeRow({ agency: null, priceQuoted: 18500 });
    const input = buildEnrichmentInput(gs, { agency: "USACE" });
    assert.deepEqual(input, {
      clientId: "el",
      title: "Test opportunity",
      noticeId: "abc123",
      solNumber: "W912HZ-26-Q-0042",
      agency: "USACE",
    });
    // Conflicting/absent fields stay undefined so the upsert preserves them.
    assert.equal("priceQuoted" in input, false);
    assert.equal("status" in input, false);
  });

  it("never smuggles timestamps into the upsert input", () => {
    const gs = makeRow();
    const input = buildEnrichmentInput(gs, {
      agency: "GSA",
      createdAt: 123,
      updatedAt: 456,
    } as Partial<MergeRow>);
    assert.equal("createdAt" in input, false);
    assert.equal("updatedAt" in input, false);
    assert.equal(input.agency, "GSA");
  });
});

describe("buildImportInput", () => {
  it("carries every substantive field and the resolved status", () => {
    const row = makeRow({ status: "triaged_watch", competitorsEst: "5" });
    const input = buildImportInput(row);
    assert.equal(input.title, "Test opportunity");
    assert.equal(input.status, "triaged_watch");
    assert.equal(input.competitorsEst, "5");
    assert.equal(input.noticeId, "abc123");
    // Timestamps are the upsert's own concern.
    assert.equal("createdAt" in input, false);
    assert.equal("updatedAt" in input, false);
  });
});
