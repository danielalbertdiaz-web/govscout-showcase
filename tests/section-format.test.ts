// Regression tests for the first-sentence cutoff bug (Item 1.4).
//
// The old stripSectionHeader (`/^##\s+.*$/m`) clipped the opening sentence of
// each draft section: the `m` flag matched in-body subheadings and the greedy
// `.*$` ate run-on prose. These tests pin the fix: the body's first sentence
// must always survive, across section shapes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { stripSectionHeader } from "../lib/section-format";

test("canonical: heading on its own line, multi-paragraph body — first sentence present", () => {
  const input = [
    "## Executive Summary",
    "",
    "Acme Consulting Group LLC is pleased to submit this proposal.",
    "",
    "We bring a consortium of behavioral-health partners to the work.",
  ].join("\n");
  const out = stripSectionHeader(input);
  assert.ok(out.startsWith("Acme Consulting Group LLC is pleased to submit this proposal."));
  assert.ok(!out.includes("## Executive Summary"));
  assert.ok(out.includes("We bring a consortium")); // body fully intact
});

test("no blank line between heading and body — first sentence still present", () => {
  const input = "## Capability Statement\nAcme Consulting holds an active 8(a) certification.";
  const out = stripSectionHeader(input);
  assert.equal(out, "Acme Consulting holds an active 8(a) certification.");
});

test("in-body subheading is NOT deleted (the old `m`-flag bug)", () => {
  const input = [
    "## Technical Approach",
    "",
    "Our approach is phased.",
    "",
    "## Consortium configuration",
    "- Partner A",
  ].join("\n");
  const out = stripSectionHeader(input);
  assert.ok(out.startsWith("Our approach is phased."));
  assert.ok(out.includes("## Consortium configuration"), "in-body subheading preserved");
});

test("run-on: heading and first sentence share one line — body not clipped", () => {
  const input = "## Past Performance. Acme delivered the Harbor County pilot on time.";
  const out = stripSectionHeader(input);
  // Safety net keeps content rather than returning empty / clipping the sentence.
  assert.ok(out.includes("Acme delivered the Harbor County pilot on time."));
});

test("heading with a colon in the title strips cleanly", () => {
  const input = "## Past Performance: Harbor County\n\nThe pilot served 1,200 clients.";
  const out = stripSectionHeader(input);
  assert.equal(out, "The pilot served 1,200 clients.");
});

test("# and ### levels are handled", () => {
  assert.equal(stripSectionHeader("# Summary\n\nBody here."), "Body here.");
  assert.equal(stripSectionHeader("### Sub\n\nBody here."), "Body here.");
});

test("no heading at all — text passes through unchanged", () => {
  const input = "Just a paragraph with no heading. Second sentence.";
  assert.equal(stripSectionHeader(input), input);
});

test("never returns empty when there was input", () => {
  assert.equal(stripSectionHeader("## Reviewer Notes"), "Reviewer Notes");
  assert.equal(stripSectionHeader("   "), "");
});
