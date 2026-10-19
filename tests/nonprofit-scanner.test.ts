import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  scoreNonprofitCandidate,
  rankNonprofitCandidates,
  candidateThemes,
  NONPROFIT_SCORE_WEIGHTS,
} from "../lib/nonprofit-scanner";
import type { NonprofitCandidate } from "../lib/nonprofit-sources/types";
import type { ReferenceOrg } from "../lib/reference-orgs";

function cand(over: Partial<NonprofitCandidate> = {}): NonprofitCandidate {
  return {
    ein: "221234567",
    name: "Prevention Links",
    nteeCode: "F20",
    missionSummary: null,
    city: "Roselle",
    state: "NJ",
    revenueUsd: null,
    source: "propublica",
    sourceUrl: null,
    ...over,
  };
}

function ref(over: Partial<ReferenceOrg> = {}): ReferenceOrg {
  return {
    id: "x",
    kind: "google_org_winner",
    name: "Prevention Links",
    focusAreas: [],
    geography: null,
    sourceUrl: null,
    note: null,
    amountUsd: null,
    year: null,
    ein: null,
    ...over,
  };
}

describe("candidateThemes", () => {
  it("prefers NTEE classification over text inference", () => {
    assert.deepEqual(candidateThemes(cand({ nteeCode: "F22" })), ["substance_use"]);
  });
  it("falls back to text inference when no NTEE code", () => {
    const themes = candidateThemes(cand({ nteeCode: null, missionSummary: "reentry support for the formerly incarcerated" }));
    assert.ok(themes.includes("reentry"));
  });
});

describe("scoreNonprofitCandidate", () => {
  it("awards full theme + geography + budget for an aligned NJ org with revenue", () => {
    const s = scoreNonprofitCandidate(
      cand({ revenueUsd: 4200000 }),
      { themes: ["substance_use", "behavioral_health"] },
    );
    // F20 -> [substance_use, behavioral_health]; both overlap -> high theme credit
    assert.ok(s.relevanceScore >= NONPROFIT_SCORE_WEIGHTS.geography + NONPROFIT_SCORE_WEIGHTS.budget);
    assert.ok(s.reasons.some((r) => /Theme match/.test(r)));
    assert.ok(s.reasons.some((r) => /home-state/.test(r)));
    assert.ok(s.reasons.length <= 3);
  });

  it("adds the reference-winner signal when name matches a Google.org winner", () => {
    const withRef = scoreNonprofitCandidate(cand(), { themes: ["substance_use"], referenceOrgs: [ref()] });
    const without = scoreNonprofitCandidate(cand(), { themes: ["substance_use"] });
    assert.equal(withRef.relevanceScore - without.relevanceScore, NONPROFIT_SCORE_WEIGHTS.reference);
    assert.ok(withRef.reasons.some((r) => /Google\.org/.test(r)));
  });

  it("does not award geography for a non-home state", () => {
    const s = scoreNonprofitCandidate(cand({ state: "TX" }), { themes: ["substance_use"] });
    assert.equal(s.reasons.some((r) => /home-state/.test(r)), false);
  });

  it("clamps to 0-100 and always returns at least one reason", () => {
    const s = scoreNonprofitCandidate(
      cand({ nteeCode: null, missionSummary: null, name: "Unknown Org", state: "TX" }),
      { themes: ["health"] },
    );
    assert.ok(s.relevanceScore >= 0 && s.relevanceScore <= 100);
    assert.ok(s.reasons.length >= 1);
  });
});

describe("rankNonprofitCandidates", () => {
  it("ranks higher-scoring candidates first", () => {
    const ranked = rankNonprofitCandidates({
      themes: ["substance_use"],
      candidates: [
        cand({ name: "Off Theme TX", nteeCode: "B20", state: "TX" }),
        cand({ name: "On Theme NJ", nteeCode: "F22", state: "NJ", revenueUsd: 1000000 }),
      ],
    });
    assert.equal(ranked[0].name, "On Theme NJ");
    assert.ok(ranked[0].relevanceScore > ranked[1].relevanceScore);
  });

  it("drops candidates whose dedupeKey is excluded (partner/contact/dispositioned)", () => {
    const ranked = rankNonprofitCandidates({
      themes: ["substance_use"],
      candidates: [cand({ name: "Prevention Links, Inc." }), cand({ name: "Integrity House" })],
      excludeKeys: ["org:prevention links"], // referenceDedupeKey strips inc/punctuation
    });
    const names = ranked.map((r) => r.name);
    assert.equal(names.includes("Prevention Links, Inc."), false);
    assert.ok(names.includes("Integrity House"));
  });

  it("de-dupes within a single batch", () => {
    const ranked = rankNonprofitCandidates({
      themes: ["substance_use"],
      candidates: [cand({ name: "Integrity House" }), cand({ name: "Integrity House" })],
    });
    assert.equal(ranked.length, 1);
  });

  it("honors the limit", () => {
    const ranked = rankNonprofitCandidates({
      themes: ["substance_use"],
      candidates: [cand({ name: "A" }), cand({ name: "B" }), cand({ name: "C" })],
      limit: 2,
    });
    assert.equal(ranked.length, 2);
  });
});
