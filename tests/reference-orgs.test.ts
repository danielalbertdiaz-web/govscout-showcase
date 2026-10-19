import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  normalizeReferenceOrg,
  normalizeReferenceDataset,
  filterReferenceOrgs,
  focusAreasOf,
  referenceDedupeKey,
  matchesTheme,
  type ReferenceOrg,
} from "../lib/reference-orgs";

const SEED = {
  metadata: { note: "seed" },
  google_org_winners: [
    {
      id: "gow-vera",
      name: "Vera Institute of Justice",
      focus_areas: ["justice_reform", "data_research"],
      geography: "New York, NY",
      amount_usd: 4000000,
      year: 2017,
      source_url: "https://example.org/vera",
      note: "jail data",
    },
    {
      // no id -> slug from name; snake_case fields
      name: "The JED Foundation",
      focus_areas: ["youth_mental_health", "behavioral_health"],
      geography: "US (national)",
      source_url: "https://example.org/jed",
    },
  ],
  nonprofits: [
    {
      id: "np-integrity",
      name: "Integrity House",
      focus_areas: ["substance_use_treatment", "recovery"],
      geography: "Centerville, NJ",
      source_url: "https://example.org/integrity",
    },
  ],
};

describe("reference-orgs", () => {
  it("normalizeReferenceOrg requires a name and assigns kind + slug id", () => {
    assert.equal(normalizeReferenceOrg({}, "nonprofit"), null);
    assert.equal(normalizeReferenceOrg({ name: "  " }, "nonprofit"), null);
    const o = normalizeReferenceOrg(
      { name: "Code for America", focus_areas: ["civic_tech"] },
      "google_org_winner",
      "gow",
    );
    assert.ok(o);
    assert.equal(o!.kind, "google_org_winner");
    assert.equal(o!.id, "code-for-america");
    assert.deepEqual(o!.focusAreas, ["civic_tech"]);
    assert.equal(o!.amountUsd, null);
  });

  it("normalizeReferenceOrg accepts both snake_case and camelCase + dedupes focus areas", () => {
    const o = normalizeReferenceOrg(
      { name: "X", focusAreas: ["a", "a", "b"], sourceUrl: "https://x", amountUsd: 100 },
      "nonprofit",
    );
    assert.deepEqual(o!.focusAreas, ["a", "b"]);
    assert.equal(o!.sourceUrl, "https://x");
    assert.equal(o!.amountUsd, 100);
  });

  it("normalizeReferenceDataset flattens winners + nonprofits with the right kinds", () => {
    const ds = normalizeReferenceDataset(SEED);
    assert.equal(ds.orgs.length, 3);
    assert.equal(ds.orgs.filter((o) => o.kind === "google_org_winner").length, 2);
    assert.equal(ds.orgs.filter((o) => o.kind === "nonprofit").length, 1);
    assert.equal(ds.metadata.note, "seed");
    // missing-id record slugs from its name
    assert.ok(ds.orgs.some((o) => o.id === "the-jed-foundation"));
  });

  it("normalizeReferenceDataset never throws on junk input", () => {
    assert.deepEqual(normalizeReferenceDataset(null).orgs, []);
    assert.deepEqual(normalizeReferenceDataset({ google_org_winners: "nope" }).orgs, []);
  });

  it("filterReferenceOrgs filters by kind, focus area, geography, and free text", () => {
    const ds = normalizeReferenceDataset(SEED);
    assert.equal(filterReferenceOrgs(ds.orgs, { kind: "nonprofit" }).length, 1);
    assert.equal(
      filterReferenceOrgs(ds.orgs, { focusArea: "behavioral_health" }).length,
      1,
    );
    assert.equal(filterReferenceOrgs(ds.orgs, { geography: "nj" }).length, 1);
    assert.equal(filterReferenceOrgs(ds.orgs, { q: "vera" }).length, 1);
    // "all" kind is a no-op filter
    assert.equal(filterReferenceOrgs(ds.orgs, { kind: "all" }).length, 3);
  });

  it("focusAreasOf returns the sorted distinct set", () => {
    const ds = normalizeReferenceDataset(SEED);
    assert.deepEqual(focusAreasOf(ds.orgs), [
      "behavioral_health",
      "data_research",
      "justice_reform",
      "recovery",
      "substance_use_treatment",
      "youth_mental_health",
    ]);
  });

  it("referenceDedupeKey is stable across legal suffixes and punctuation", () => {
    const a = referenceDedupeKey("The Fortune Society, Inc.");
    const b = referenceDedupeKey("Fortune Society");
    assert.equal(a, b);
    assert.notEqual(referenceDedupeKey("Integrity House"), a);
  });

  it("matchesTheme overlaps focus areas against theme keywords", () => {
    const org: ReferenceOrg = {
      id: "x",
      kind: "nonprofit",
      name: "X",
      focusAreas: ["substance_use_treatment", "recovery"],
      geography: null,
      sourceUrl: null,
      note: null,
      amountUsd: null,
      year: null,
      ein: null,
    };
    assert.equal(matchesTheme(org, ["substance_use", "reentry"]), true); // substring
    assert.equal(matchesTheme(org, ["youth"]), false);
    assert.equal(matchesTheme(org, []), false);
  });
});
