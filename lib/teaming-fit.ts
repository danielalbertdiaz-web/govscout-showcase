// Item 5.2 — teaming-fit scoring (pure, fully testable).
//
// The brief asks for "council deliberation adapted for teaming": for a subaward
// notice, the decision is NOT "is this a good grant" but "should Acme Consulting +
// TechPartners raise their hand as a SUB". The criteria are re-weighted from the
// partner-fit model (4.2) accordingly:
//
//   - SCOPE FIT (0.35) — does the work match what Acme/TechPartners actually do?
//     NAICS in our target set + capability-keyword hits in the scope, with a
//     bonus when it lands in the behavioral-health practice.
//   - SUB-ROLE CAPACITY (0.30) — is there room for a small sub? Sources Sought /
//     Special Notice are sub-friendly (prime still forming the team); a posted
//     Solicitation is later-stage. Small-business set-asides boost.
//   - RELATIONSHIP WITH PRIME (0.25) — do we already know the prime? A named
//     prime we have a contact/partner record for is the warmest path in.
//   - PRIME QUALITY (0.10, secondary) — is there a credible named prime + agency?
//
// Pure: takes a normalized notice + a plain context, returns a 0–100 score with
// top-3 reasons / risks. No db, no fs, no model.

import {
  type TeamingNotice,
  BEHAVIORAL_HEALTH_NAICS,
  naicsMatches,
} from "./teaming-sources/types";

export const TEAMING_FIT_WEIGHTS = {
  scopeFit: 0.35,
  subRoleCapacity: 0.3,
  relationshipWithPrime: 0.25,
  primeQuality: 0.1,
} as const;

export type TeamingFitWeights = typeof TEAMING_FIT_WEIGHTS;

// A notice scoring below this is "not worth raising a hand for".
export const TEAMING_FIT_THRESHOLD = 40;

export type TeamingContext = {
  /** What Acme Consulting + TechPartners can field as a sub (lowercased phrases ok). */
  capabilityKeywords: string[];
  /** Org names we already have a relationship with (partners 4.1 + contacts 4.3). */
  knownPrimeNames: string[];
  /** Target NAICS set; empty ⇒ every NAICS counts as in-scope. */
  targetNaics: string[];
};

export type TeamingFit = {
  noticeId: string;
  fitScore: number; // 0–100 composite
  reasons: string[];
  risks: string[];
  /** True when the notice names a prime we already know. */
  knownPrime: boolean;
  components: {
    scopeFit: number;
    subRoleCapacity: number;
    relationshipWithPrime: number;
    primeQuality: number;
  };
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

function capabilityHits(capabilities: string[], scopeText: string): string[] {
  const lower = scopeText.toLowerCase();
  const tokens = tokenize(scopeText);
  const hits: string[] = [];
  for (const cap of capabilities) {
    const phrase = cap.trim().toLowerCase().replace(/_/g, " ");
    if (!phrase) continue;
    if (lower.includes(phrase)) {
      hits.push(cap);
      continue;
    }
    const cTokens = phrase.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (cTokens.some((t) => tokens.has(t))) hits.push(cap);
  }
  return hits;
}

// Notice type → how much room a small sub has. Earlier-stage notices (the prime
// is still assembling the team) score higher than a posted solicitation.
function noticeTypeCapacity(notice: TeamingNotice): number {
  switch (notice.noticeType) {
    case "Sources Sought":
      return 1; // explicitly hunting for capability — best entry point
    case "Special Notice":
      return 0.85;
    case "Presolicitation":
      return 0.7;
    case "Combined Synopsis/Solicitation":
      return 0.5;
    case "Solicitation":
      return 0.4; // prime likely already teaming
    default:
      return 0.5;
  }
}

function nameMatches(prime: string, known: string[]): boolean {
  const p = prime.trim().toLowerCase();
  if (!p) return false;
  return known.some((k) => {
    const kk = k.trim().toLowerCase();
    if (!kk) return false;
    return p === kk || p.includes(kk) || kk.includes(p);
  });
}

export function scoreTeamingFit(
  notice: TeamingNotice,
  ctx: TeamingContext,
  weights: TeamingFitWeights = TEAMING_FIT_WEIGHTS,
): TeamingFit {
  const scopeText = `${notice.title} ${notice.description ?? ""}`;
  const hits = capabilityHits(ctx.capabilityKeywords, scopeText);
  const inScope = naicsMatches(notice.naics, ctx.targetNaics);
  const isBehavioral = notice.naics ? BEHAVIORAL_HEALTH_NAICS.has(notice.naics.trim()) : false;

  // Scope fit: NAICS in-scope is the floor; capability hits + BH adjacency lift it.
  let scopeFit = inScope ? 0.5 : 0.1;
  if (hits.length) scopeFit += Math.min(hits.length * 0.2, 0.4);
  if (isBehavioral) scopeFit += 0.1;
  scopeFit = Math.min(scopeFit, 1);

  // Sub-role capacity: notice-type entry point, lifted by a small-business set-aside.
  let subRoleCapacity = noticeTypeCapacity(notice);
  const setAside = (notice.setAside ?? "").toLowerCase();
  if (/small business|sba|8\(a\)|wosb|sdvosb|hubzone|veteran|disadvantaged/.test(setAside)) {
    subRoleCapacity = Math.min(subRoleCapacity + 0.15, 1);
  }

  // Relationship with prime.
  const prime = notice.prime?.trim() ?? "";
  const knownPrime = prime ? nameMatches(prime, ctx.knownPrimeNames) : false;
  const relationshipWithPrime = knownPrime ? 1 : prime ? 0.4 : 0.2;

  // Prime quality (secondary): a named prime + a named agency reads as a real,
  // credible opportunity vs. a bare placeholder. Unknown ⇒ neutral 0.5.
  let primeQuality = 0.5;
  if (prime && notice.agency) primeQuality = 0.8;
  else if (prime || notice.agency) primeQuality = 0.6;

  const weightSum =
    weights.scopeFit +
    weights.subRoleCapacity +
    weights.relationshipWithPrime +
    weights.primeQuality || 1;
  const composite =
    (100 *
      (weights.scopeFit * scopeFit +
        weights.subRoleCapacity * subRoleCapacity +
        weights.relationshipWithPrime * relationshipWithPrime +
        weights.primeQuality * primeQuality)) /
    weightSum;

  const reasonsRanked: Array<{ s: number; text: string }> = [];
  if (hits.length)
    reasonsRanked.push({
      s: weights.scopeFit * scopeFit,
      text: `Scope match: ${hits.slice(0, 3).join(", ")}`,
    });
  if (isBehavioral)
    reasonsRanked.push({ s: weights.scopeFit * 0.1, text: "Behavioral-health NAICS — fits the SUD practice" });
  if (knownPrime)
    reasonsRanked.push({
      s: weights.relationshipWithPrime,
      text: `Existing relationship with prime "${prime}"`,
    });
  if (subRoleCapacity >= 0.85)
    reasonsRanked.push({
      s: weights.subRoleCapacity * subRoleCapacity,
      text: `${notice.noticeType} — early-stage, room for a sub`,
    });
  if (/small business|sba|8\(a\)|wosb|sdvosb|hubzone|veteran|disadvantaged/.test(setAside))
    reasonsRanked.push({ s: weights.subRoleCapacity * 0.15, text: `Set-aside: ${notice.setAside}` });

  const risksRanked: Array<{ s: number; text: string }> = [];
  if (!inScope)
    risksRanked.push({ s: weights.scopeFit, text: "NAICS outside Acme/TechPartners' target set" });
  if (hits.length === 0)
    risksRanked.push({ s: weights.scopeFit * 0.6, text: "No direct capability keywords in the scope" });
  if (!prime)
    risksRanked.push({ s: weights.relationshipWithPrime, text: "No named prime — cold path in" });
  else if (!knownPrime)
    risksRanked.push({ s: weights.relationshipWithPrime * 0.6, text: `Prime "${prime}" is not a known relationship` });
  if (notice.noticeType === "Solicitation")
    risksRanked.push({ s: weights.subRoleCapacity, text: "Posted solicitation — prime may already have its team" });
  if (!notice.responseDeadline)
    risksRanked.push({ s: 0.05, text: "No response deadline on the notice — verify timing" });

  return {
    noticeId: notice.noticeId,
    fitScore: Math.round(composite),
    reasons: reasonsRanked.sort((a, b) => b.s - a.s).slice(0, 3).map((r) => r.text),
    risks: risksRanked.sort((a, b) => b.s - a.s).slice(0, 3).map((r) => r.text),
    knownPrime,
    components: { scopeFit, subRoleCapacity, relationshipWithPrime, primeQuality },
  };
}

export type RankTeamingInput = {
  notices: TeamingNotice[];
  ctx: TeamingContext;
  weights?: TeamingFitWeights;
  limit?: number;
};

export type RankedTeamingNotice = { notice: TeamingNotice; fit: TeamingFit };

// Score every notice, sort by fit (then known-prime, then scope), cap to limit.
export function rankTeamingNotices(input: RankTeamingInput): RankedTeamingNotice[] {
  const weights = input.weights ?? TEAMING_FIT_WEIGHTS;
  const ranked = input.notices
    .map((notice) => ({ notice, fit: scoreTeamingFit(notice, input.ctx, weights) }))
    .sort(
      (a, b) =>
        b.fit.fitScore - a.fit.fitScore ||
        Number(b.fit.knownPrime) - Number(a.fit.knownPrime) ||
        b.fit.components.scopeFit - a.fit.components.scopeFit ||
        a.notice.title.localeCompare(b.notice.title),
    );
  return input.limit ? ranked.slice(0, input.limit) : ranked;
}
