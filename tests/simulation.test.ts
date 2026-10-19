import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  buildPredictionRequirement,
  assembleBundleDocuments,
  parsePredictionReport,
  simulationConfigured,
} from "../lib/simulation";

const BUNDLE = {
  nofoTitle: "HRSA-26-036 RCORP-Planning",
  nofoText: "Full NOFO text here.",
  capabilityStatement: "Acme Consulting capability statement.",
  competitiveLandscape: ["Acme Rural Health (incumbent)", "BigFirm LLC"],
};

describe("simulation bundle (pure)", () => {
  it("prediction requirement embeds title, panel, and Acme by name", () => {
    const req = buildPredictionRequirement(BUNDLE);
    assert.match(req, /HRSA-26-036 RCORP-Planning/);
    assert.match(req, /Acme Consulting Group LLC/);
    assert.match(req, /percentage/);
    // applicants default = competitors + Acme
    assert.match(req, /Evaluate 3 competing applicants/);
  });

  it("bundle documents carry NOFO, capability, and competitive docs", () => {
    const docs = assembleBundleDocuments(BUNDLE);
    assert.equal(docs.length, 3);
    assert.match(docs[0].content, /Full NOFO text/);
    assert.match(docs[2].content, /Acme Rural Health/);
    // empty landscape degrades to a generic field, never an empty doc
    const generic = assembleBundleDocuments({ ...BUNDLE, competitiveLandscape: [] });
    assert.match(generic[2].content, /typical field/);
  });
});

describe("parsePredictionReport (pure, tolerant)", () => {
  it("extracts Acme-adjacent win probability + sections", () => {
    const md = [
      "# Prediction Report",
      "## Rankings",
      "1. Acme Rural Health — 45%",
      "2. Acme Consulting Group LLC — selection likelihood 30%",
      "3. BigFirm LLC — 25%",
      "## Weaknesses",
      "- No prior HRSA award history as prime applicant",
      "- Rural service footprint is thin relative to incumbents",
      "## Recommendations",
      "- Lead with the Riverside clinical partnership to offset incumbency",
    ].join("\n");
    const v = parsePredictionReport(md);
    assert.equal(v.winProbability, 30); // Acme's line, not Acme's 45
    assert.equal(v.weaknesses.length, 2);
    assert.match(v.weaknesses[0], /HRSA award history/);
    assert.equal(v.recommendations.length, 1);
    assert.match(v.recommendations[0], /Riverside/);
  });

  it("degrades gracefully on junk", () => {
    const v = parsePredictionReport("no structure at all here");
    assert.equal(v.winProbability, null);
    assert.deepEqual(v.weaknesses, []);
    assert.deepEqual(v.recommendations, []);
  });

  it("rejects out-of-range percentages", () => {
    const v = parsePredictionReport("Acme Consulting scored 250% better than baseline");
    assert.equal(v.winProbability, null);
  });

  // Regression fixture from the FIRST REAL run (report_431647b53eb6,
  // 2026-06-11): the old parser returned 75% — Applicant A's number — because
  // the first Acme mention was a narrative line with no %, and the heading
  // matcher required sections to START with "Weakness".
  it("real run-3 shape: Acme ranked last, verbose headings", () => {
    const md = [
      "# Future Prediction Report: HRSA RCORP-Planning Grant Review Simulation",
      "",
      "> The simulation predicts a competitive review where Acme Consulting Group LLC faces significant challenges.",
      "",
      "## Grant Review Panel Dynamics and Applicant Evaluation",
      "",
      "*   **Applicant A:** 75% likelihood of award. Strong alignment with all criteria.",
      "*   **Applicant B:** 70% likelihood of award. Innovative approach and strong capacity.",
      "*   **Acme Consulting Group LLC:** 25% likelihood of award. Significant weaknesses identified.",
      "",
      "## Acme Consulting Group LLC's Application Weaknesses and Award Probability",
      "",
      "*   **Organizational Capacity:** insufficient detail on staffing for a rural consortium.",
      "*   **Implementation Plan:** milestones lack measurable interim outcomes.",
      "",
      "## Recommended Positioning Adjustments for Future Applications",
      "",
      "*   Name a FORHP-designated rural county and document consortium letters of intent.",
      "*   Add a sustainability narrative tied to opioid settlement funds.",
    ].join("\n");
    const v = parsePredictionReport(md);
    assert.equal(v.winProbability, 25); // Acme's own row, not Applicant A's 75
    assert.equal(v.weaknesses.length, 2);
    assert.match(v.weaknesses[0], /Organizational Capacity/);
    assert.equal(v.recommendations.length, 2);
    assert.match(v.recommendations[0], /FORHP/);
  });

  it("falls back to a range midpoint near the Acme mention", () => {
    const md =
      "Based on the panel's assessment, the predicted award probability for Acme Consulting Group LLC is estimated in the range of **15-25%**.";
    const v = parsePredictionReport(md);
    assert.equal(v.winProbability, 20);
  });

  it("configured() follows the env seam", () => {
    const prev = process.env.MIROFISH_BASE_URL;
    try {
      delete process.env.MIROFISH_BASE_URL;
      assert.equal(simulationConfigured(), false);
      process.env.MIROFISH_BASE_URL = "http://localhost:5001";
      assert.equal(simulationConfigured(), true);
    } finally {
      if (prev !== undefined) process.env.MIROFISH_BASE_URL = prev;
      else delete process.env.MIROFISH_BASE_URL;
    }
  });
});
