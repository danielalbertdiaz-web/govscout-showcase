import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, suggestCorrection } from "../lib/search-spelling";

test("editDistance basics", () => {
  assert.equal(editDistance("opiod", "opioid", 2), 1);
  assert.equal(editDistance("same", "same", 2), 0);
  assert.ok(editDistance("xyz", "opioid", 2) > 2);
});

test("corrects the live-reported typo: opiod → opioid", () => {
  assert.equal(suggestCorrection("opiod"), "opioid");
});

test("corrects a typo inside a phrase, preserving the rest", () => {
  assert.equal(suggestCorrection("rural opiod treatment"), "rural opioid treatment");
});

test("correct queries pass through (null = no retry)", () => {
  assert.equal(suggestCorrection("opioid"), null);
  assert.equal(suggestCorrection("behavioral health"), null);
  assert.equal(suggestCorrection("cybersecurity"), null);
});

test("short tokens and unknown jargon are left alone", () => {
  // "ai" too short to fuzz; a random string matches nothing within distance.
  assert.equal(suggestCorrection("ai"), null);
  assert.equal(suggestCorrection("zzqqxx funding"), null);
});

test("tech + awareness vocabulary is covered (multi-vertical)", () => {
  assert.equal(suggestCorrection("brodband"), "broadband");
  assert.equal(suggestCorrection("awarness campaign"), "awareness campaign");
});
