// Unit tests for the boilerplate disk-seed transform (Item 2.1).
//
// deriveBlockFromFile / parseBlockEntries are pure: filename + content in,
// structured seed block out. These pin the title/category/needs_review/key
// derivation that the seeder relies on, with no fs or db.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveBlockFromFile,
  parseBlockEntries,
  slugFromFilename,
} from "../lib/block-seed";

test("slug strips numeric prefix and .md extension", () => {
  assert.equal(slugFromFilename("01-org-overview.md"), "org-overview");
  assert.equal(slugFromFilename("11-maine-ems-partnership-template.md"), "maine-ems-partnership-template");
  assert.equal(slugFromFilename("README.md"), "readme");
});

test("title comes from the first H1", () => {
  const b = deriveBlockFromFile(
    "01-org-overview.md",
    "# Acme Consulting — Organizational Overview\n\nDrop-in language for background sections.\n",
  );
  assert.equal(b.title, "Acme Consulting — Organizational Overview");
  assert.equal(b.key, "org-overview");
});

test("title falls back to a title-cased slug when there is no H1", () => {
  const b = deriveBlockFromFile("04-indirect-rates.md", "Some body without a heading.");
  assert.equal(b.title, "Indirect Rates");
});

test("notes lifts the first descriptor line after the heading", () => {
  const b = deriveBlockFromFile(
    "01-org-overview.md",
    "# Org Overview\n\nDrop-in language for Agency Overview sections.\n\n---\n\nBody.",
  );
  assert.equal(b.notes, "Drop-in language for Agency Overview sections.");
});

test("category derivation by filename keyword", () => {
  const cat = (f: string) => deriveBlockFromFile(f, "# x\n\nbody").category;
  assert.equal(cat("02-alex-doe-bio.md"), "personnel");
  assert.equal(cat("03-dr-reed-bio.md"), "personnel");
  assert.equal(cat("04-indirect-rates.md"), "financials");
  assert.equal(cat("05-partner-roster.md"), "partners");
  assert.equal(cat("13-citation-library.md"), "reference");
  assert.equal(cat("07-nine-pillars-architecture.md"), "narrative");
  assert.equal(cat("01-org-overview.md"), "organization");
  assert.equal(cat("99-something-unmapped.md"), "general");
});

test("needs_review when the body carries human-input placeholders", () => {
  const flag = (body: string) => deriveBlockFromFile("x.md", `# t\n\n${body}`).status;
  assert.equal(flag("**[RESEARCH FLAG: confirm NJ ME system]**"), "needs_review");
  assert.equal(flag("current baseline: [insert current turnaround time]"), "needs_review");
  assert.equal(flag("> **[County] Medical Examiner Toxicology"), "needs_review");
  assert.equal(flag("leadership (TBD per RESEARCH FLAG)"), "needs_review");
});

test("ready when the body is complete prose with no placeholders", () => {
  const b = deriveBlockFromFile(
    "01-org-overview.md",
    "# Org Overview\n\nAcme Consulting Group LLC is a New Jersey firm. We are ready.",
  );
  assert.equal(b.status, "ready");
});

test("parseBlockEntries skips README and non-markdown and empty files", () => {
  const out = parseBlockEntries([
    { filename: "README.md", content: "# Library docs\n\nnot content" },
    { filename: "notes.txt", content: "ignored" },
    { filename: "01-org-overview.md", content: "# Org Overview\n\nReady prose." },
    { filename: "02-empty.md", content: "   \n  " },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "org-overview");
});

test("deterministic key — same filename always yields the same key (idempotency basis)", () => {
  const a = deriveBlockFromFile("05-partner-roster.md", "# Partners\n\nA").key;
  const b = deriveBlockFromFile("05-partner-roster.md", "# Partners\n\nB (edited)").key;
  assert.equal(a, b);
  assert.equal(a, "partner-roster");
});
