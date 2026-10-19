// Unit tests for the Working Draft assembler (Item 2.2).
//
// assembleWorkingDraft is pure: a list of promoted blocks in order -> one
// combined markdown document. These pin ordering, heading shape, the optional
// document title, empty-skip behavior, and — critically — that every block is
// run through the 1.6 partner-copy sanitizer so internal copy can't leak into
// the assembled, exportable document.

import { test } from "node:test";
import assert from "node:assert/strict";

import { assembleWorkingDraft } from "../lib/working-draft";

test("joins blocks in order with ## headings", () => {
  const out = assembleWorkingDraft([
    { title: "Capability Statement", bodyMarkdown: "Acme Consulting is ready." },
    { title: "Past Performance", bodyMarkdown: "We delivered the Harbor pilot." },
  ]);
  const iCap = out.indexOf("## Capability Statement");
  const iPast = out.indexOf("## Past Performance");
  assert.ok(iCap >= 0 && iPast >= 0);
  assert.ok(iCap < iPast, "blocks preserve pane order");
  assert.ok(out.includes("Acme Consulting is ready."));
  assert.ok(out.includes("We delivered the Harbor pilot."));
});

test("optional document title renders as a top-level # heading", () => {
  const out = assembleWorkingDraft(
    [{ title: "Summary", bodyMarkdown: "Body." }],
    { documentTitle: "RFP-300-2026 Response" },
  );
  assert.ok(out.startsWith("# RFP-300-2026 Response"));
});

test("runs every block through the 1.6 sanitizer (no internal copy leaks)", () => {
  const out = assembleWorkingDraft([
    {
      title: "Approach",
      bodyMarkdown: "This is not a PG/debt scenario and Riverside will greenlight anything.",
    },
  ]);
  assert.ok(!/PG\/debt/i.test(out), "internal PG/debt framing stripped");
  assert.ok(!/greenlight anything/i.test(out), "disparaging phrase stripped");
});

test("skips blocks that are empty after trimming", () => {
  const out = assembleWorkingDraft([
    { title: "", bodyMarkdown: "" },
    { title: "Real", bodyMarkdown: "Has content." },
  ]);
  assert.equal((out.match(/##/g) ?? []).length, 1);
  assert.ok(out.includes("## Real"));
});

test("empty pane yields empty string", () => {
  assert.equal(assembleWorkingDraft([]), "");
});

test("a block with a title but no body still emits its heading", () => {
  const out = assembleWorkingDraft([{ title: "Budget Narrative", bodyMarkdown: "   " }]);
  assert.ok(out.includes("## Budget Narrative"));
});
