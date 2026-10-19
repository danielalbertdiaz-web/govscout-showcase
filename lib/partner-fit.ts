// Item 4.2 — partner-fit auto-ranking (pure, fully testable).
//
// For an opportunity, score each candidate partner 0–100 on how well they fit,
// with the top-3 supporting reasons and top-3 risks, then rank them and emit a
// team/solo/pass recommendation. This module is pure: it takes already-loaded
// profiles + a plain opportunity context and returns a ranking. No db, no fs,
// no model — so the weighting can be exercised exhaustively in tests.
//
// Design choices (all tunable, documented):
//   - Capability overlap dominates (0.45): a partner you bring for a capability
//     you can't field yourself is the whole point of teaming.
//   - Geography (0.20) with an explicit NJ/FL home-turf bias — Acme's core market.
//   - Past performance relevance (0.15): a prior engagement that echoes the
//     opportunity theme is strong, concrete proof.
//   - Status/availability (0.10): preferred > active > probationary.
//   - Disposition boost (0.10): partners on prior *wins* earn a tailwind (3.1).
// Threshold 40 splits "worth teaming" from "no fit". With no partner ≥40 we
// recommend solo vs pass off the opportunity's own strategic score.

import type { PartnerProfile } from "./partner-profiles";

// Acme Consulting's home market. A partner that serves these states fits local
// opportunities better; the bias is explicit and tunable, not buried.
export const HOME_STATES = ["NJ", "FL"] as const;

export const PARTNER_FIT_WEIGHTS = {
  capability: 0.45,
  geography: 0.2,
  pastPerformance: 0.15,
  status: 0.1,
  disposition: 0.1,
} as const;

export type PartnerFitWeights = typeof PARTNER_FIT_WEIGHTS;

// The "≥6/10" gate in the brief, normalized to the 0–100 strategicScore scale.
export const SCORE_GATE_0_100 = 60;
// A partner scoring below this is "no fit" for teaming purposes.
export const FIT_THRESHOLD = 40;

export type OpportunityContext = {
  // Free text we scan for capability + theme hits: title + summary + eligibility.
  text: string;
  // Two-letter state codes mentioned by/relevant to the opportunity, if known.
  states: string[];
  // 0–100 strategic score (null when unscored) — used only for the solo/pass call.
  strategicScore: number | null;
};

export type PartnerFit = {
  id: string;
  name: string;
  type: string;
  fitScore: number; // 0–100 composite
  reasons: string[]; // top-3 supporting factors
  risks: string[]; // top-3 caveats
  // component sub-scores (0–1) for transparency / the UI
  components: {
    capability: number;
    geography: number;
    pastPerformance: number;
    status: number;
    disposition: number;
  };
};

export type FitRecommendation = "team" | "solo" | "pass";

export type PartnerFitRanking = {
  ranked: PartnerFit[];
  best: PartnerFit | null;
  recommendation: FitRecommendation;
  recommendationReason: string;
  weights: PartnerFitWeights;
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

// A capability hits if its full phrase is present, or any of its >=4-char tokens
// appears in the opportunity text. Capabilities are often snake_case
// ("behavioral_health"), so we split on non-alphanumerics first.
function capabilityHits(capabilities: string[], oppTokens: Set<string>, oppText: string): string[] {
  const lower = oppText.toLowerCase();
  const hits: string[] = [];
  for (const cap of capabilities) {
    const phrase = cap.trim().toLowerCase().replace(/_/g, " ");
    if (!phrase) continue;
    if (lower.includes(phrase)) {
      hits.push(cap);
      continue;
    }
    const tokens = phrase.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (tokens.some((t) => oppTokens.has(t))) hits.push(cap);
  }
  return hits;
}

function statusScoreOf(status: string): number {
  const s = status.trim().toLowerCase();
  if (s === "preferred" || s === "primary") return 1;
  if (s === "active" || s === "") return 0.7;
  if (s === "probation" || s === "pending") return 0.4;
  if (s === "inactive") return 0;
  return 0.5;
}

// Geography: full credit when the partner serves a state the opportunity touches;
// partial credit for serving a home state (NJ/FL) even absent an explicit match;
// neutral 0.5 when the partner's geography is simply unknown (don't punish a
// blank profile into "bad fit"). 0 only when known-and-disjoint.
function geographyScore(partnerStates: string[], oppStates: string[]): number {
  if (partnerStates.length === 0) return 0.5; // unknown, not bad
  const pset = new Set(partnerStates.map((s) => s.toUpperCase()));
  const oset = oppStates.map((s) => s.toUpperCase());
  if (oset.some((s) => pset.has(s))) return 1;
  const homeServed = (HOME_STATES as readonly string[]).some((s) => pset.has(s));
  if (oppStates.length === 0) return homeServed ? 0.7 : 0.4; // no opp geo known
  return homeServed ? 0.3 : 0; // known but disjoint
}

// Past performance is relevant if any of its scope/client tokens land in the
// opportunity text. Returns the count of relevant entries and the score.
function pastPerformanceScore(
  pastPerformance: PartnerProfile["pastPerformance"],
  oppTokens: Set<string>,
): { score: number; relevant: number } {
  if (pastPerformance.length === 0) return { score: 0, relevant: 0 };
  let relevant = 0;
  for (const pp of pastPerformance) {
    const tokens = tokenize(`${pp.scope} ${pp.client}`);
    if ([...tokens].some((t) => oppTokens.has(t))) relevant += 1;
  }
  // Saturating: one relevant prior is already strong; two+ is full marks.
  const score = relevant === 0 ? 0.1 : relevant >= 2 ? 1 : 0.6;
  return { score, relevant };
}

// Score a single partner against an opportunity. dispositionWins is the number
// of prior WON opportunities that named this partner (from 3.1 history).
export function scorePartnerFit(
  profile: PartnerProfile,
  opp: OpportunityContext,
  dispositionWins = 0,
  weights: PartnerFitWeights = PARTNER_FIT_WEIGHTS,
): PartnerFit {
  const oppTokens = tokenize(opp.text);
  const hits = capabilityHits(profile.capabilities, oppTokens, opp.text);
  const capability =
    profile.capabilities.length > 0
      ? Math.min(hits.length / Math.min(profile.capabilities.length, 3), 1)
      : 0;
  const geography = geographyScore(profile.geography.states, opp.states);
  const pp = pastPerformanceScore(profile.pastPerformance, oppTokens);
  const status = statusScoreOf(profile.status);
  const disposition = dispositionWins === 0 ? 0 : dispositionWins >= 2 ? 1 : 0.6;

  const weightSum =
    weights.capability +
    weights.geography +
    weights.pastPerformance +
    weights.status +
    weights.disposition || 1;
  const composite =
    (100 *
      (weights.capability * capability +
        weights.geography * geography +
        weights.pastPerformance * pp.score +
        weights.status * status +
        weights.disposition * disposition)) /
    weightSum;

  // Reasons (positive contributions), ordered by strength.
  const reasonsRanked: Array<{ s: number; text: string }> = [];
  if (hits.length)
    reasonsRanked.push({
      s: weights.capability * capability,
      text: `Capability match: ${hits.slice(0, 3).join(", ")}`,
    });
  if (geography >= 0.7)
    reasonsRanked.push({
      s: weights.geography * geography,
      text: profile.geography.states.length
        ? `Serves ${profile.geography.states.join("/")}${opp.states.length ? " — overlaps opportunity geography" : " (home market)"}`
        : "Geographic footprint aligns",
    });
  if (pp.relevant > 0)
    reasonsRanked.push({
      s: weights.pastPerformance * pp.score,
      text: `${pp.relevant} relevant past-performance reference${pp.relevant > 1 ? "s" : ""}`,
    });
  if (dispositionWins > 0)
    reasonsRanked.push({
      s: weights.disposition * disposition,
      text: `Prior win${dispositionWins > 1 ? "s" : ""} on similar opportunities`,
    });
  if (status >= 1)
    reasonsRanked.push({ s: weights.status * status, text: "Preferred partner status" });

  // Risks (gaps), ordered by how much they cost.
  const risksRanked: Array<{ s: number; text: string }> = [];
  if (hits.length === 0)
    risksRanked.push({ s: weights.capability, text: "No direct capability overlap with this opportunity" });
  if (geography === 0)
    risksRanked.push({ s: weights.geography, text: "Geographic footprint does not cover the opportunity" });
  else if (profile.geography.states.length === 0)
    risksRanked.push({ s: weights.geography * 0.5, text: "Geographic coverage unconfirmed" });
  if (pp.relevant === 0)
    risksRanked.push({
      s: weights.pastPerformance,
      text: "No directly relevant past performance on file",
    });
  if (profile.certifications.length === 0)
    risksRanked.push({ s: 0.05, text: "No certifications listed — confirm eligibility set-asides" });
  if (!profile.contact.email)
    risksRanked.push({ s: 0.04, text: "No partner contact email on file" });
  if (status < 0.7)
    risksRanked.push({ s: weights.status, text: `Partner status is "${profile.status}"` });

  const reasons = reasonsRanked
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((r) => r.text);
  const risks = risksRanked
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((r) => r.text);

  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    fitScore: Math.round(composite),
    reasons,
    risks,
    components: { capability, geography, pastPerformance: pp.score, status, disposition },
  };
}

export type RankPartnerFitInput = {
  profiles: PartnerProfile[];
  opp: OpportunityContext;
  // 4.1 include/exclude: when `includedIds` is non-undefined, ONLY those ids are
  // ranked (the curated roster). `excludedIds` always removes ids.
  includedIds?: string[];
  excludedIds?: string[];
  // partnerId -> count of prior wins naming them (from 3.1 disposition history).
  dispositionWins?: Record<string, number>;
  weights?: PartnerFitWeights;
};

export function rankPartnerFit(input: RankPartnerFitInput): PartnerFitRanking {
  const weights = input.weights ?? PARTNER_FIT_WEIGHTS;
  const excluded = new Set(input.excludedIds ?? []);
  const includeSet = input.includedIds ? new Set(input.includedIds) : null;

  const candidates = input.profiles.filter((p) => {
    if (excluded.has(p.id)) return false;
    if (includeSet && !includeSet.has(p.id)) return false;
    return true;
  });

  const ranked = candidates
    .map((p) => scorePartnerFit(p, input.opp, input.dispositionWins?.[p.id] ?? 0, weights))
    .sort(
      (a, b) =>
        b.fitScore - a.fitScore ||
        b.components.capability - a.components.capability ||
        a.name.localeCompare(b.name),
    );

  const best = ranked[0] ?? null;

  let recommendation: FitRecommendation;
  let recommendationReason: string;
  if (best && best.fitScore >= FIT_THRESHOLD) {
    recommendation = "team";
    recommendationReason = `${best.name} fits at ${best.fitScore}/100 — team to strengthen the bid.`;
  } else {
    // No partner clears the bar. Decide solo vs pass from the opportunity's own
    // strategic score: a strong opportunity is worth pursuing solo; a weak one
    // with no teaming upside is a pass candidate. (Assumption, documented.)
    const score = input.opp.strategicScore;
    if (score != null && score < 50) {
      recommendation = "pass";
      recommendationReason = `No partner scores ≥${FIT_THRESHOLD} and the opportunity scores ${score}/100 — consider passing.`;
    } else {
      recommendation = "solo";
      recommendationReason =
        best == null
          ? "No candidate partners — pursue solo if Acme can field the scope."
          : `No partner scores ≥${FIT_THRESHOLD} (best ${best.name} at ${best.fitScore}) — pursue solo.`;
    }
  }

  return { ranked, best, recommendation, recommendationReason, weights };
}

// Cheap, dependency-free geography sniff for an opportunity's free text. Scans
// for the two home-market state names/abbreviations Acme cares about. Extensible
// later; intentionally conservative (word-boundary on the abbreviation).
export function sniffOpportunityStates(text: string): string[] {
  const found = new Set<string>();
  const lower = ` ${text.toLowerCase()} `;
  if (/\bnew jersey\b/.test(lower) || /\bn\.?j\.?\b/.test(lower)) found.add("NJ");
  if (/\bflorida\b/.test(lower) || /\bfl\b/.test(lower)) found.add("FL");
  return [...found];
}
