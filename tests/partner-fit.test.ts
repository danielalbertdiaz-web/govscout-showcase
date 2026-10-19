import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePartnerProfile,
  deriveProfileFromPartner,
  partnerFacingProfile,
  type PartnerProfile,
} from "../lib/partner-profiles";
import {
  scorePartnerFit,
  rankPartnerFit,
  sniffOpportunityStates,
  FIT_THRESHOLD,
  type OpportunityContext,
} from "../lib/partner-fit";
import { composePartnerIntro } from "../lib/partner-intro";
import { introDraftRelPath } from "../lib/outreach-files";

function profile(over: Partial<PartnerProfile>): PartnerProfile {
  return {
    id: "p",
    name: "P",
    type: "t",
    status: "active",
    capabilities: [],
    certifications: [],
    geography: { states: [], footprint: "" },
    pastPerformance: [],
    contact: { human: null, email: null },
    dealStructure: "",
    introBlurb: "",
    redLines: [],
    internalNotes: null,
    ...over,
  };
}

const opp = (over: Partial<OpportunityContext> = {}): OpportunityContext => ({
  text: "",
  states: [],
  strategicScore: null,
  ...over,
});

// ---- profiles -------------------------------------------------------------

test("normalizePartnerProfile coerces partial JSON and uppercases states", () => {
  const p = normalizePartnerProfile(
    { id: "x", name: "X", capabilities: ["a", 2], geography: { states: ["nj", "fl"] } },
    "fallback",
  );
  assert.ok(p);
  assert.deepEqual(p!.capabilities, ["a", "2"]);
  assert.deepEqual(p!.geography.states, ["NJ", "FL"]);
  assert.equal(p!.status, "active");
});

test("normalizePartnerProfile uses idHint and rejects shapeless input", () => {
  assert.equal(normalizePartnerProfile(null), null);
  assert.equal(normalizePartnerProfile({ name: "no id" }), null);
  assert.equal(normalizePartnerProfile({ name: "with hint" }, "hint")!.id, "hint");
});

test("deriveProfileFromPartner routes integration_notes to internal-only, never facing", () => {
  const derived = deriveProfileFromPartner({
    id: "riverside",
    name: "Riverside",
    type: "community_partner",
    description: "Community services partner",
    capabilities: ["behavioral_health"],
    commission_structure: "partnership_based",
    integration_notes: "Will greenlight whatever Acme proposes. Not a PG/debt scenario.",
    contact: "Riverside leadership",
    status: "active",
  });
  // internal framing lands in internalNotes...
  assert.match(derived.internalNotes ?? "", /greenlight/i);
  // ...and the partner-facing projection is sanitized clean of it.
  const facing = partnerFacingProfile(derived);
  const blob = JSON.stringify(facing).toLowerCase();
  assert.ok(!blob.includes("greenlight"));
  assert.ok(!blob.includes("pg/debt"));
});

test("partnerFacingProfile drops redLines/internalNotes entirely", () => {
  const facing = partnerFacingProfile(
    profile({ redLines: ["secret guardrail"], internalNotes: "private" }),
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(facing, "redLines"));
  assert.ok(!Object.prototype.hasOwnProperty.call(facing, "internalNotes"));
});

// ---- fit scoring ----------------------------------------------------------

test("capability overlap drives a high fit score", () => {
  const fit = scorePartnerFit(
    profile({ capabilities: ["behavioral_health", "substance_abuse_treatment"], status: "preferred" }),
    opp({ text: "Behavioral health and substance abuse treatment grant", states: ["NJ"] }),
  );
  assert.ok(fit.fitScore >= FIT_THRESHOLD, `expected >= ${FIT_THRESHOLD}, got ${fit.fitScore}`);
  assert.ok(fit.reasons.some((r) => /capability/i.test(r)));
});

test("no capability overlap surfaces a risk and a low score", () => {
  const fit = scorePartnerFit(
    profile({ capabilities: ["media_buying"], geography: { states: ["NJ"], footprint: "" } }),
    opp({ text: "Wetlands remediation engineering services", states: ["NJ"] }),
  );
  assert.ok(fit.fitScore < FIT_THRESHOLD);
  assert.ok(fit.risks.some((r) => /no direct capability overlap/i.test(r)));
});

test("geography: home-state served beats a known-disjoint footprint", () => {
  const njFit = scorePartnerFit(
    profile({ capabilities: ["x"], geography: { states: ["NJ"], footprint: "" } }),
    opp({ text: "x services", states: ["NJ"] }),
  );
  const txFit = scorePartnerFit(
    profile({ capabilities: ["x"], geography: { states: ["TX"], footprint: "" } }),
    opp({ text: "x services", states: ["NJ"] }),
  );
  assert.ok(njFit.components.geography > txFit.components.geography);
  assert.equal(txFit.components.geography, 0);
});

test("prior wins (3.1) give a partner a tailwind", () => {
  const base = profile({ capabilities: ["healthcare_services"] });
  const ctx = opp({ text: "healthcare services" });
  const withWins = scorePartnerFit(base, ctx, 2);
  const without = scorePartnerFit(base, ctx, 0);
  assert.ok(withWins.fitScore > without.fitScore);
});

test("rankPartnerFit recommends team when the best clears the threshold", () => {
  const r = rankPartnerFit({
    profiles: [
      profile({ id: "a", name: "A", capabilities: ["behavioral_health"], status: "preferred", geography: { states: ["NJ"], footprint: "" } }),
      profile({ id: "b", name: "B", capabilities: ["media_buying"] }),
    ],
    opp: opp({ text: "behavioral health services in New Jersey", states: ["NJ"], strategicScore: 80 }),
  });
  assert.equal(r.recommendation, "team");
  assert.equal(r.best?.id, "a");
});

test("rankPartnerFit: no fit + weak opportunity => pass; strong => solo", () => {
  const profiles = [profile({ id: "b", name: "B", capabilities: ["media_buying"] })];
  const weak = rankPartnerFit({ profiles, opp: opp({ text: "bridge inspection", strategicScore: 30 }) });
  assert.equal(weak.recommendation, "pass");
  const strong = rankPartnerFit({ profiles, opp: opp({ text: "bridge inspection", strategicScore: 85 }) });
  assert.equal(strong.recommendation, "solo");
});

test("rankPartnerFit honors 4.1 include/exclude", () => {
  const profiles = [
    profile({ id: "a", name: "A", capabilities: ["x"] }),
    profile({ id: "b", name: "B", capabilities: ["x"] }),
    profile({ id: "c", name: "C", capabilities: ["x"] }),
  ];
  const ctx = opp({ text: "x services" });
  const onlyAB = rankPartnerFit({ profiles, opp: ctx, includedIds: ["a", "b"] });
  assert.deepEqual(onlyAB.ranked.map((r) => r.id).sort(), ["a", "b"]);
  const noB = rankPartnerFit({ profiles, opp: ctx, excludedIds: ["b"] });
  assert.ok(!noB.ranked.some((r) => r.id === "b"));
});

test("sniffOpportunityStates detects NJ and FL", () => {
  assert.deepEqual(sniffOpportunityStates("State of New Jersey DOH grant").sort(), ["NJ"]);
  assert.deepEqual(sniffOpportunityStates("Florida and New Jersey consortium").sort(), ["FL", "NJ"]);
  assert.deepEqual(sniffOpportunityStates("California water board"), []);
});

// ---- intro composer (1.6) -------------------------------------------------

test("composePartnerIntro is partner-safe and never leaks internal framing", () => {
  const p = profile({
    id: "riverside",
    name: "Riverside",
    capabilities: ["behavioral_health"],
    contact: { human: "Jane Doe", email: "jane@riverside.example.org" },
    dealStructure: "partnership-based",
    // simulate a mis-authored facing field carrying banned copy
    introBlurb: "Riverside will greenlight anything we send.",
  });
  const intro = composePartnerIntro(
    p,
    { id: "rfp-1", title: "Behavioral Health Grant", agency: "NJ DOH", deadline: "2026-07-01", summary: "Funds behavioral health services." },
    scorePartnerFit(p, opp({ text: "behavioral health services" })),
  );
  assert.ok(!/greenlight/i.test(intro.markdown));
  assert.ok(intro.markdown.includes("Jane"));
  assert.ok(intro.markdown.includes("NOTHING HAS BEEN SENT"));
});

test("introDraftRelPath is path-safe against id injection", () => {
  const p = introDraftRelPath("../../etc", "a/b");
  assert.ok(!p.includes(".."));
  assert.ok(p.endsWith("-intro.md"));
});
