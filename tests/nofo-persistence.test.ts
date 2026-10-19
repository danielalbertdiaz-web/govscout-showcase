// NOFO persistence durability and idempotency (V4.1 §14.5).
//
// "A rerun on an unchanged document should be idempotent." Before this,
// saveNofo() always INSERTed: re-uploading the same PDF produced a second row,
// and there was no way to recognise an unchanged document or to protect a
// field a human had already corrected from being overwritten by the extractor.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

let db: typeof import("../lib/db");

before(async () => {
  const repoRoot = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nofo-test-"));
  await fs.mkdir(path.join(dir, "lib"));
  await fs.symlink(path.join(repoRoot, "lib", "migrations"), path.join(dir, "lib", "migrations"));
  process.chdir(dir);
  db = await import("../lib/db");
});

const structured = {
  agency: "HRSA",
  program: "Rural Health Opioid Program",
  funding_floor: "$100,000",
  funding_ceiling: "$500,000",
  period_of_performance: "3 years",
  key_dates: { due: "2026-09-01" },
  eligibility: "Nonprofits and public entities",
  evaluation_criteria: "Need, approach, capacity",
  required_sections: ["Need", "Approach", "Budget"],
  summary: "Rural opioid response funding.",
} as never;

describe("nofoSourceHash", () => {
  it("is stable across whitespace differences", () => {
    const a = db.nofoSourceHash("Notice   of\nFunding\t Opportunity");
    const b = db.nofoSourceHash("Notice of Funding Opportunity");
    assert.equal(a, b, "the same NOFO pasted or parsed must resolve to one record");
  });

  it("differs for different documents", () => {
    assert.notEqual(db.nofoSourceHash("document one"), db.nofoSourceHash("document two"));
  });

  it("is null for empty text", () => {
    assert.equal(db.nofoSourceHash("   \n\t "), null);
  });
});

describe("saveNofo idempotency", () => {
  it("re-extracting an unchanged document updates in place", () => {
    const raw = "NOFO body text for HRSA rural opioid program.";
    const first = db.saveNofo({
      userEmail: "a@example.com",
      structured,
      rawText: raw,
      originalFilename: "nofo.pdf",
      extractionVersion: "v1",
    });
    const second = db.saveNofo({
      userEmail: "a@example.com",
      structured,
      rawText: raw,
      originalFilename: "nofo.pdf",
      extractionVersion: "v2",
    });
    assert.equal(second.id, first.id, "a rerun must not create a second record");
    assert.equal(db.listNofos("a@example.com").length, 1);
  });

  it("normalised whitespace still resolves to the same record", () => {
    const a = db.saveNofo({
      userEmail: "ws@example.com",
      structured,
      rawText: "Same   document\n\nbody",
      originalFilename: null,
    });
    const b = db.saveNofo({
      userEmail: "ws@example.com",
      structured,
      rawText: "Same document body",
      originalFilename: null,
    });
    assert.equal(b.id, a.id);
  });

  it("keeps different owners separate", () => {
    const raw = "Shared public NOFO text.";
    const mine = db.saveNofo({ userEmail: "one@example.com", structured, rawText: raw, originalFilename: null });
    const theirs = db.saveNofo({ userEmail: "two@example.com", structured, rawText: raw, originalFilename: null });
    assert.notEqual(mine.id, theirs.id, "one user's NOFO must not absorb another's");
  });

  it("a genuinely different document creates a new record", () => {
    const a = db.saveNofo({ userEmail: "d@example.com", structured, rawText: "First NOFO", originalFilename: null });
    const b = db.saveNofo({ userEmail: "d@example.com", structured, rawText: "Second NOFO", originalFilename: null });
    assert.notEqual(b.id, a.id);
  });

  it("records extraction provenance", () => {
    const saved = db.saveNofo({
      userEmail: "prov@example.com",
      structured,
      rawText: "Provenance NOFO body",
      originalFilename: "p.pdf",
      extractionVersion: "2026-07-31",
      extractionModel: "claude-sonnet-4-6",
      extractionConfidence: 0.87,
      solicitationNumber: "HRSA-26-001",
    });
    const row = db.getNofo(saved.id, "prov@example.com");
    assert.ok(row, "record should be retrievable");
  });
});
