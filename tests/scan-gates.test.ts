// Deterministic scanner scoring gates (SCANNER_SCORING_DEFECT_PACKET) — pure
// detector tests. Fixtures use the real disqualifying/scale text from the
// three cited solicitations: FD2399-26-00126 (AGI STK, brand-name/sole-source
// in the notice text, scored 75/100 anyway), ACWS26-CFS-001 (Army-wide CSO,
// scored 100/100 off its own "Agentic AI" framing), and 693JJ926R000007
// (NHTSA, 60-month T&M with 4,173 staffed hours, scored 72 then 80).
//
// The posture under test is the packet's hardest rule: exclude ONLY on a
// positive match against a known pattern; when uncertain, admit and mark
// unclassified. Absence of evidence is never disqualification.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  admitEligibility,
  detectScaleSignals,
  sanitiseScaleSignals,
  mergeScaleSignals,
  resolveScoreBasis,
  SCALE_SIGNAL_SCORE_CAP,
} from "../lib/scan-gates";

// FD2399-26-00126 — the FAR citation and reseller clause were in the notice
// text the scanner already had. It did not need the attachment for this one.
const AGI_STK_TEXT =
  "Ansys Government Initiatives (AGI) Systems Tool Kit (STK), Enterprise Collection Planner licenses. " +
  "The Government intends to award on a brand name basis pursuant to FAR 16.505(a)(4)(i). " +
  "Only an authorized Ansys/AGI STK reseller may submit a quotation.";

// ACWS26-CFS-001 — enterprise scale everywhere, but NO eligibility fact: a
// large program can contain a small Acme-shaped carve-out, so Tier 1 must admit.
const ACWS_TEXT =
  "Army Contract Writing System (ACWS) Sustainment, Support, and Enhancement — Final Call for Solutions " +
  "under a Commercial Solutions Opening (CSO). Scope includes Agentic AI/automation, IL-6 secure cloud " +
  "hosting, Virtual Contracting Enterprise (VCE) integration, and Tier 3 operations support.";

// 693JJ926R000007 — the staffing gate lives in the 81-page RFP, but this is
// the shape of that text once the attachment (or a fuller notice) is read.
const NHTSA_TEXT =
  "Developing a Smartphone App to Enhance Older Driver Safety. 60-month time and materials (T&M) research " +
  "contract. Year 1 staffing totals 4,173 hours across six labor categories (PI/PM, Research Associate, " +
  "Research Assistants, APP Designer, APP Developer). Requires IRB-managed naturalistic driving studies " +
  "with participants aged 65 and older, and a mandatory third-party Independent QA Reviewer credentialed " +
  "in gerontechnology and Section 508/WCAG 2.1 AA.";

describe("admitEligibility (Tier 1)", () => {
  it("excludes the AGI STK notice on its FAR 16.505(a)(4)(i) citation", () => {
    const verdict = admitEligibility(AGI_STK_TEXT);
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.admitted === false && verdict.reason, "sole_source_brand_name");
    assert.match(verdict.admitted === false ? verdict.evidence : "", /16\.505/);
  });

  it("matches citation spacing variants", () => {
    for (const cite of ["FAR 16.505(a)(4)(i)", "FAR 16.505 (a)(4)", "16.505(a)(4)", "far 16.505 ( a ) ( 4 ) ( i )"]) {
      assert.equal(admitEligibility(`Award per ${cite}.`).admitted, false, cite);
    }
  });

  it("excludes an explicit authorized-reseller-only clause without a FAR citation", () => {
    const verdict = admitEligibility("Only an authorized Esri reseller may respond to this solicitation.");
    assert.equal(verdict.admitted, false);
    assert.equal(verdict.admitted === false && verdict.reason, "authorized_reseller_only");
    const variants = [
      "Quotes will be accepted from authorized resellers only.",
      "The vendor must be an authorized AGI STK reseller.",
      "Only authorized distributors of the OEM may quote.",
    ];
    for (const v of variants) assert.equal(admitEligibility(v).admitted, false, v);
  });

  it("ADMITS when uncertain — loose language is never a positive match", () => {
    const uncertain = [
      ACWS_TEXT, // enterprise scale is Tier 2's business, not an eligibility fact
      NHTSA_TEXT,
      // Bare "sole source" words without a known citation pattern:
      "Sole source procurement is not contemplated; this is full and open competition.",
      // The wrong FAR paragraph must not match:
      "Fair opportunity exception per FAR 16.505(b)(2)(i)(B).",
      // Bare section number:
      "See FAR 16.505 for ordering procedures.",
      "Resellers are welcome alongside OEMs and integrators.",
      "",
    ];
    for (const text of uncertain) {
      const verdict = admitEligibility(text);
      assert.equal(verdict.admitted, true, text || "(empty)");
      assert.equal(verdict.reason, "unclassified", "admission is never a finding of eligibility");
    }
    assert.equal(admitEligibility(null).admitted, true, "absence of text is not evidence");
  });
});

describe("detectScaleSignals (Tier 2)", () => {
  it("names the ACWS enterprise signals: CSO, IL-6, VCE", () => {
    const kinds = detectScaleSignals(ACWS_TEXT).map((s) => s.kind);
    assert.deepEqual(kinds, ["impact_level", "cso", "vce"]);
  });

  it("names the NHTSA staffing signals: hours, reviewer, IRB, multi-year T&M", () => {
    const signals = detectScaleSignals(NHTSA_TEXT);
    const kinds = signals.map((s) => s.kind);
    assert.deepEqual(kinds, ["staffed_labor_hours", "multi_year_tm", "credentialed_reviewer", "human_subjects"]);
    const hours = signals.find((s) => s.kind === "staffed_labor_hours");
    assert.match(hours?.evidence ?? "", /4,173/);
  });

  it("finds nothing in Acme-shaped micro-contract text", () => {
    assert.deepEqual(
      detectScaleSignals(
        "Firm-fixed-price purchase order for an AI chatbot pilot, 90-day period of performance, single deliverable.",
      ),
      [],
    );
    assert.deepEqual(detectScaleSignals(null), []);
  });

  it("multi_year_tm is compound: T&M alone or a long PoP alone is not the signal", () => {
    assert.deepEqual(detectScaleSignals("T&M line items may be proposed."), []);
    assert.deepEqual(detectScaleSignals("60-month ordering period, firm fixed price."), []);
  });
});

describe("sanitiseScaleSignals / mergeScaleSignals", () => {
  it("keeps known kinds (bare or with evidence), drops junk, dedupes", () => {
    const out = sanitiseScaleSignals([
      "cso",
      { kind: "staffed_labor_hours", evidence: "4,173 hrs yr 1 (RFP §B)" },
      { kind: "staffed_labor_hours", evidence: "duplicate" },
      { kind: "sounds_scary", evidence: "made-up kind" },
      "not_a_kind",
      42,
      null,
    ]);
    assert.deepEqual(
      out.map((s) => s.kind),
      ["cso", "staffed_labor_hours"],
    );
    assert.equal(out[1].evidence, "4,173 hrs yr 1 (RFP §B)");
    assert.deepEqual(sanitiseScaleSignals("not an array"), []);
  });

  it("merge is a kind-deduped union in vocabulary order (first evidence wins)", () => {
    const merged = mergeScaleSignals(
      [{ kind: "vce", evidence: "stored" }],
      [{ kind: "cso", evidence: "detected" }, { kind: "vce", evidence: "later" }],
    );
    assert.deepEqual(merged, [
      { kind: "cso", evidence: "detected" },
      { kind: "vce", evidence: "stored" },
    ]);
  });
});

describe("score basis (the attachment gate vocabulary)", () => {
  it("only an exact positive assertion reads as verified — everything else is notice_only", () => {
    assert.equal(resolveScoreBasis("attachment_reviewed"), "attachment_reviewed");
    for (const claim of [undefined, null, "", "verified", "attachment reviewed", "ATTACHMENT_REVIEWED", "llm says fine"]) {
      assert.equal(resolveScoreBasis(claim), "notice_only", String(claim));
    }
  });

  it("the cap sits below the scanners' pull-the-RFP-above-70 line", () => {
    assert.ok(SCALE_SIGNAL_SCORE_CAP < 70);
  });
});
