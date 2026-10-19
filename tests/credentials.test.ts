// Audit finding A-1: Acme Consulting's identifiers lived in SEED_BLOCKS as
// literal "[insert ...]" placeholders inside approved, drafting-reachable
// blocks — a capability statement would have emitted placeholder text to a
// funder. These pin the real values (UEI EXAMPLEUEI00, CAGE 0ZZZ0, MBE
// Confirmation Number 00000000000) AND that the values the operator did not supply
// (MBE effective/expiration dates) remain visible placeholders — a wrong date
// in a compliance document is worse than an obvious blank.
// Pure assertions on the seed catalogue; no db. Migration 035 applies the
// same values to live rows.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SEED_BLOCKS } from "../lib/boilerplate";

const byKey = (key: string) => {
  const block = SEED_BLOCKS.find((b) => b.key === key);
  assert.ok(block, `seed block missing: ${key}`);
  return block!;
};

describe("credential values (audit A-1)", () => {
  it("UEI and CAGE seed blocks carry no [insert placeholders", () => {
    for (const key of ["acme-consulting-uei", "acme-consulting-cage"]) {
      assert.ok(!byKey(key).bodyMarkdown.includes("[insert"), `${key} still has a placeholder`);
    }
    assert.ok(
      !byKey("acme-consulting-capability-statement").bodyMarkdown.includes("[insert canonical UEI"),
      "capability statement still has the UEI placeholder",
    );
  });

  it("the UEI block contains exactly EXAMPLEUEI00", () => {
    assert.equal(byKey("acme-consulting-uei").bodyMarkdown.trim(), "EXAMPLEUEI00");
  });

  it("the CAGE block exists and contains 0ZZZ0", () => {
    const cage = byKey("acme-consulting-cage");
    assert.equal(cage.bodyMarkdown.trim(), "0ZZZ0");
    assert.equal(cage.title, "Acme Consulting — CAGE Code");
  });

  it("the MBE block has the Confirmation Number and the operator's month-year dates", () => {
    const body = byKey("acme-consulting-mbe-cert").bodyMarkdown;
    assert.ok(body.includes("Confirmation Number: 00000000000"), "confirmation number missing");
    assert.ok(!body.includes("[insert cert number]"), "old certificate placeholder should be gone");
    assert.ok(!body.includes("Certificate #"), "must not be relabelled Certificate # — the operator supplied a confirmation number");
    // Dates supplied 2026-08-04 as "1/2025" and "1/2030" — month + year only.
    assert.ok(body.includes("Effective: January 2025"));
    assert.ok(body.includes("Expiration: January 2030"));
    assert.ok(!body.includes("[insert date]"), "date placeholders should be resolved");
  });

  it("the MBE dates carry no invented precision — no ISO-style date anywhere in the block", () => {
    // the operator gave month and year, not a day. A fabricated day-of-month in a
    // compliance document is the failure mode this pins against.
    const body = byKey("acme-consulting-mbe-cert").bodyMarkdown;
    assert.doesNotMatch(body, /\d{4}-\d{2}-\d{2}/);
  });

  it("the contact-info block carries the federal-grant address of record with no placeholder", () => {
    const body = byKey("acme-consulting-contact-info").bodyMarkdown;
    assert.ok(body.includes("123 Main Street"), "street address missing");
    assert.ok(body.includes("Springfield, ST 00000"), "city/state/zip missing");
    assert.match(body, /federal-grant address of record/i);
    assert.ok(!body.includes("[insert"), "no placeholder may remain in the contact block");
  });

  it("the capability statement contains both UEI and CAGE values", () => {
    const body = byKey("acme-consulting-capability-statement").bodyMarkdown;
    assert.ok(body.includes("**UEI:** EXAMPLEUEI00"));
    assert.ok(body.includes("**CAGE:** 0ZZZ0"));
  });
});
