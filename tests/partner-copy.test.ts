// Tests for the partner-facing copy sanitizer (Item 1.6, layer 2).
//
// The two named exposures: "Riverside will greenlight anything" (disparaging) and
// "not a PG/debt scenario" (internal framing) must never survive to a
// partner-facing render. Dead-relationship names get a visible [redacted]
// marker so a reviewer notices, never a silent drop.

import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizePartnerCopy, isPartnerSafe } from "../lib/partner-copy";

test("strips the Riverside 'greenlight anything' disparagement", () => {
  const r = sanitizePartnerCopy("Riverside will greenlight anything we send them.");
  assert.ok(!/greenlight/i.test(r.clean));
  assert.equal(r.safe, false);
  assert.ok(r.redactions.some((x) => x.rule === "disparage-greenlight"));
});

test("strips 'not a PG/debt scenario' internal framing", () => {
  const r = sanitizePartnerCopy("This is not a PG/debt scenario, just a partnership.");
  assert.ok(!/PG\/debt/i.test(r.clean));
  assert.equal(r.safe, false);
  assert.match(r.clean, /just a partnership\./);
});

test("strips a bare PG/debt token too (extensible rule)", () => {
  const r = sanitizePartnerCopy("Frame the Brightline as PG/debt internally.");
  assert.ok(!/PG\/debt/i.test(r.clean));
});

test("dead-relationship names become a visible [redacted] marker", () => {
  const r = sanitizePartnerCopy("Loop in Jane Barred and the LRS team about OldPartnerCo.");
  assert.ok(!/Jane Barred|OldPartnerCo/i.test(r.clean));
  assert.match(r.clean, /\[redacted\]/);
  assert.equal(r.redactions.filter((x) => x.rule === "dead-relationship").length, 3);
});

test("dead-relationship emails are escaped and matched", () => {
  const r = sanitizePartnerCopy("cc banned.contact@example.org on this.");
  assert.ok(!/banned_contact@example\.org/.test(r.clean));
});

test("clean partner copy passes through untouched and reports safe", () => {
  const original =
    "Acme Consulting is pleased to confirm its partnership with Riverside Community Action Corporation on this opportunity.";
  const r = sanitizePartnerCopy(original);
  assert.equal(r.clean, original);
  assert.equal(r.safe, true);
  assert.equal(r.redactions.length, 0);
  assert.equal(isPartnerSafe(original), true);
});

test("case-insensitive and whitespace is tidied after removal", () => {
  const r = sanitizePartnerCopy("They  WILL  GREENLIGHT  ANYTHING , honestly.");
  assert.ok(!/greenlight/i.test(r.clean));
  assert.ok(!/  /.test(r.clean), "no doubled spaces left");
  assert.ok(!/\s,/.test(r.clean), "no space before comma left");
});

test("null/undefined/empty input is safe", () => {
  assert.equal(sanitizePartnerCopy(null).safe, true);
  assert.equal(sanitizePartnerCopy(undefined).clean, "");
  assert.equal(sanitizePartnerCopy("").safe, true);
});

test("isPartnerSafe flags unsafe text", () => {
  assert.equal(isPartnerSafe("greenlight anything"), false);
  assert.equal(isPartnerSafe("a perfectly normal sentence"), true);
});
