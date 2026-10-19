// The ingest score gate (migration 042, SCANNER_SCORING_DEFECT_PACKET) — the
// only path by which ai_deliverability_score/score_basis/scale_signals are
// written, covering the weekly scanner too (it ingests straight to fp without
// passing the micro staging table).
//
// Order is the point: Tier 1 short-circuits BEFORE any score handling, so an
// ingest carrying a "75/100" verdict on a positively identified sole-source
// notice never lands that number in canon — while the ROW is still written.
// Tier 2 discounts and names its reasons but never removes. A score without an
// exact "attachment_reviewed" assertion always reads notice_only.
//
// Same temp-DB isolation pattern as tests/federal-pipeline.test.ts.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { SCALE_SIGNAL_SCORE_CAP } from "../lib/scan-gates";

let fp: typeof import("../lib/federal-pipeline");
let dbmod: typeof import("../lib/db");

const AGI_DESC =
  "The Government intends to award on a brand name basis pursuant to FAR 16.505(a)(4)(i). " +
  "Only an authorized Ansys/AGI STK reseller may submit a quotation.";

const ACWS_DESC =
  "Final Call for Solutions under a Commercial Solutions Opening (CSO): Agentic AI/automation, " +
  "IL-6 secure cloud hosting, Virtual Contracting Enterprise (VCE) integration, Tier 3 ops support.";

before(async () => {
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "score-gate-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  fp = await import("../lib/federal-pipeline");
  dbmod = await import("../lib/db");
});

describe("Tier 1 at ingest: the disqualifier fires before the score exists in canon", () => {
  it("a scored sole-source ingest lands the ROW but never the verdict", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "AGI STK Enterprise Collection Planner licenses",
      noticeId: "agi-fp-1",
      solNumber: "FD2399-26-00126",
      description: AGI_DESC,
      aiDeliverabilityScore: 75, // what the weekly scanner actually sent (2026-08-03)
      scoreBasis: "attachment_reviewed", // even a verified claim cannot rescue an ineligible notice
    });
    assert.equal(res.created, true);
    // The row exists — withholding a number is not a kill.
    assert.ok(fp.findFpOpportunity("agi-fp-1"));
    // The verdict does not: no score, no basis, nothing to present confidently.
    assert.equal(res.opp.aiDeliverabilityScore, null);
    assert.equal(res.opp.scoreBasis, null);
    assert.equal(res.scoreWithheld?.reason, "sole_source_brand_name");
    assert.equal(res.scoreWithheld?.withheldScore, 75);
    // And the row stays in the candidate list — visible, never removed.
    assert.ok(fp.listFpOpportunities().some((o) => o.noticeId === "agi-fp-1"));
  });

  it("re-ingesting the same scored payload still never lands a score", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "AGI STK Enterprise Collection Planner licenses",
      noticeId: "agi-fp-1",
      description: AGI_DESC,
      aiDeliverabilityScore: 80,
    });
    assert.equal(res.opp.aiDeliverabilityScore, null);
    assert.equal(res.scoreWithheld?.withheldScore, 80);
  });

  it("a pre-fix stored score is nulled when the disqualifying text arrives, with an event on the trail", () => {
    // Simulate the pre-042 world: score ingested with no notice text.
    const seeded = fp.upsertFpOpportunity({ clientId: "el",
      title: "Legacy sole-source notice scored before the gate existed",
      noticeId: "agi-fp-legacy",
      aiDeliverabilityScore: 75,
    });
    assert.equal(seeded.opp.aiDeliverabilityScore, 75);
    // The next scan re-ingest carries the notice text.
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Legacy sole-source notice scored before the gate existed",
      noticeId: "agi-fp-legacy",
      description: AGI_DESC,
    });
    assert.equal(res.opp.aiDeliverabilityScore, null);
    assert.equal(res.scoreWithheld?.withheldScore, 75);
    const trail = fp.listFpEvents(res.opp.id);
    assert.ok(
      trail.some((e) => e.kind === "note" && e.detail?.action === "score_withheld"),
      "withholding a stored score must land on the event trail",
    );
  });

  it("uncertain text is ADMITTED: loose sole-source words never withhold a score", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Full and open AI support services",
      noticeId: "open-fp-1",
      description: "Sole source procurement is not contemplated; full and open competition.",
      aiDeliverabilityScore: 64,
    });
    assert.equal(res.scoreWithheld, undefined);
    assert.equal(res.opp.aiDeliverabilityScore, 64);
  });
});

describe("Tier 2 at ingest: discount and name, never remove", () => {
  it("the ACWS shape gets a capped score, named signals, and stays listed", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Army Contract Writing System (ACWS) Sustainment, Support, and Enhancement",
      noticeId: "acws-fp-1",
      description: ACWS_DESC,
      aiDeliverabilityScore: 100, // the real 2026-08-03 verdict
    });
    assert.equal(res.opp.aiDeliverabilityScore, SCALE_SIGNAL_SCORE_CAP);
    assert.deepEqual(res.scoreCapped, {
      rawScore: 100,
      cappedTo: SCALE_SIGNAL_SCORE_CAP,
      signals: ["impact_level", "cso", "vce"],
    });
    assert.deepEqual(
      res.opp.scaleSignals.map((s) => s.kind),
      ["impact_level", "cso", "vce"],
    );
    // Flag, don't kill: still in the candidate list.
    assert.ok(fp.listFpOpportunities().some((o) => o.noticeId === "acws-fp-1"));
  });

  it("signals are sticky: a text-less re-ingest cannot launder the score back above the cap", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Army Contract Writing System (ACWS) Sustainment, Support, and Enhancement",
      noticeId: "acws-fp-1",
      aiDeliverabilityScore: 95, // no description this time
    });
    assert.equal(res.opp.aiDeliverabilityScore, SCALE_SIGNAL_SCORE_CAP);
    assert.deepEqual(
      res.opp.scaleSignals.map((s) => s.kind),
      ["impact_level", "cso", "vce"],
    );
  });

  it("attachment-derived signals arriving AFTER a notice-only score discount it (the NHTSA flow)", () => {
    // Daily scan, notice text only: no scale signal visible, 80/100 stored.
    const first = fp.upsertFpOpportunity({ clientId: "el",
      title: "Developing a Smartphone App to Enhance Older Driver Safety",
      noticeId: "nhtsa-fp-1",
      description: "Smartphone app, UI/UX, prototype for older driver safety research.",
      aiDeliverabilityScore: 80,
    });
    assert.equal(first.opp.aiDeliverabilityScore, 80);
    assert.deepEqual(first.opp.scaleSignals, []);
    // The agent then opens the 81-page RFP and reports what it found.
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Developing a Smartphone App to Enhance Older Driver Safety",
      noticeId: "nhtsa-fp-1",
      scaleSignals: [
        { kind: "staffed_labor_hours", evidence: "4,173 hours yr 1 across 6 labor categories (RFP §B)" },
        { kind: "multi_year_tm", evidence: "60-month T&M" },
        { kind: "human_subjects", evidence: "IRB-managed naturalistic driving studies" },
        { kind: "credentialed_reviewer", evidence: "Independent QA Reviewer, gerontechnology + 508/WCAG" },
      ],
    });
    assert.equal(res.opp.aiDeliverabilityScore, SCALE_SIGNAL_SCORE_CAP);
    assert.equal(res.scoreCapped?.rawScore, 80);
    assert.equal(res.opp.scaleSignals.length, 4);
    // Still visible — routed to a human, not removed.
    assert.ok(fp.listFpOpportunities().some((o) => o.noticeId === "nhtsa-fp-1"));
  });

  it("a below-cap score is stored as sent — signals discount, they do not zero", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "CSO-adjacent but modest",
      noticeId: "modest-fp-1",
      description: "Commercial Solutions Opening for a small pilot.",
      aiDeliverabilityScore: 40,
    });
    assert.equal(res.opp.aiDeliverabilityScore, 40);
    assert.equal(res.scoreCapped, undefined);
    assert.deepEqual(
      res.opp.scaleSignals.map((s) => s.kind),
      ["cso"],
    );
  });
});

describe("the attachment gate: unverifiable never reads as verified", () => {
  it("a score with no basis claim stores as notice_only", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Scored off the notice alone",
      noticeId: "basis-fp-1",
      aiDeliverabilityScore: 55,
    });
    assert.equal(res.opp.scoreBasis, "notice_only");
  });

  it("only the exact positive assertion stores as attachment_reviewed", () => {
    const ok = fp.upsertFpOpportunity({ clientId: "el",
      title: "Scored after reading the RFP",
      noticeId: "basis-fp-2",
      aiDeliverabilityScore: 62,
      scoreBasis: "attachment_reviewed",
    });
    assert.equal(ok.opp.scoreBasis, "attachment_reviewed");
    for (const junk of ["verified", "attachment reviewed", "yes"]) {
      const res = fp.upsertFpOpportunity({ clientId: "el",
        title: "Junk basis claim",
        noticeId: `basis-junk-${junk.replace(/\W+/g, "-")}`,
        aiDeliverabilityScore: 50,
        scoreBasis: junk,
      });
      assert.equal(res.opp.scoreBasis, "notice_only", junk);
    }
  });

  it("a fresh score never inherits the previous verified basis", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Scored after reading the RFP",
      noticeId: "basis-fp-2",
      aiDeliverabilityScore: 70, // re-scored, no basis claim this time
    });
    assert.equal(res.opp.scoreBasis, "notice_only");
  });

  it("a basis-only update can mark an existing score verified without resending it", () => {
    const res = fp.upsertFpOpportunity({ clientId: "el",
      title: "Scored off the notice alone",
      noticeId: "basis-fp-1",
      scoreBasis: "attachment_reviewed",
    });
    assert.equal(res.opp.aiDeliverabilityScore, 55);
    assert.equal(res.opp.scoreBasis, "attachment_reviewed");
  });

  it("legacy pre-042 rows (score present, basis NULL) read as notice_only", () => {
    const seeded = fp.upsertFpOpportunity({ clientId: "el",
      title: "Legacy scored row",
      noticeId: "legacy-fp-1",
      aiDeliverabilityScore: 88,
    });
    // Force the pre-migration state directly: score without any basis.
    dbmod.getDb().prepare("UPDATE fp_opportunities SET score_basis = NULL WHERE id = ?").run(seeded.opp.id);
    const read = fp.findFpOpportunity("legacy-fp-1");
    assert.equal(read?.aiDeliverabilityScore, 88);
    assert.equal(read?.scoreBasis, "notice_only");
  });

  it("clearing the score clears the basis with it", () => {
    fp.upsertFpOpportunity({ clientId: "el", title: "x", noticeId: "clear-fp-1", aiDeliverabilityScore: 42 });
    const res = fp.upsertFpOpportunity({ clientId: "el", title: "x", noticeId: "clear-fp-1", aiDeliverabilityScore: null });
    assert.equal(res.opp.aiDeliverabilityScore, null);
    assert.equal(res.opp.scoreBasis, null);
  });

  it("preserve-on-upsert still holds: an ingest without score fields touches none of them", () => {
    const before = fp.findFpOpportunity("basis-fp-2")!;
    const res = fp.upsertFpOpportunity({ clientId: "el", title: "Scored after reading the RFP", noticeId: "basis-fp-2", agency: "TEST" });
    assert.equal(res.opp.aiDeliverabilityScore, before.aiDeliverabilityScore);
    assert.equal(res.opp.scoreBasis, before.scoreBasis);
    assert.deepEqual(res.opp.scaleSignals, before.scaleSignals);
  });
});
