// S1 — search → partner recommendations (pure, fully testable).
//
// "Show the grants, then find the best partner to win the grant" (operator,
// 2026-06-11). Given a search query + the grant titles it returned, rank who
// to team with: the partner ROSTER first (warm, known capabilities), then the
// Reference library (1,400+ profiled orgs). No db, no fetch, no model — the
// API route supplies the data, this ranks it.

import type { ReferenceOrg } from "./reference-orgs";
import { SCOUT_PROFILES } from "./scout-profiles";

export type MatchablePartner = {
  id: string;
  name: string;
  capabilities: string[];
  status?: string | null;
};

export type PartnerRecommendation = {
  kind: "partner" | "reference";
  id: string;
  name: string;
  score: number;
  /** Human-readable why: matched terms, focus areas, funding signals. */
  reasons: string[];
  /** Reference-only context for the outreach draft. */
  focusAreas: string[];
  geography: string | null;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "will",
  "program", "programs", "grant", "grants", "funding", "opportunity",
  "notice", "federal", "state", "fy", "fy25", "fy26", "round",
]);

/** Tokenize query + titles into a lowercase needle set (≥4 chars, no stopwords). */
export function buildNeedles(query: string, titles: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of [query, ...titles]) {
    for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length >= 4 && !STOPWORDS.has(raw)) out.add(raw);
    }
  }
  // Semantic bridge: "opioid" must match a partner whose capability says
  // "substance use treatment". The scout profiles already group each
  // vertical's vocabulary — if any profile keyword matches a needle, the
  // whole profile's vocabulary joins the needle set.
  for (const profile of SCOUT_PROFILES.filter((p) => p.enabled)) {
    const kws = profile.keywords.map((k) => k.toLowerCase());
    const touched = kws.some((kw) =>
      Array.from(out).some((n) => kw.includes(n) || n.includes(kw)),
    );
    if (touched) {
      for (const kw of kws) for (const t of kw.split(/\s+/)) if (t.length >= 4) out.add(t);
    }
  }
  return out;
}

function overlap(needles: Set<string>, phrases: string[]): string[] {
  const hits = new Set<string>();
  for (const phrase of phrases) {
    const p = phrase.toLowerCase().replace(/_/g, " ");
    for (const n of needles) {
      if (p.includes(n)) {
        hits.add(phrase.replace(/_/g, " "));
        break;
      }
    }
  }
  return Array.from(hits);
}

export function recommendPartners(input: {
  query: string;
  resultTitles: string[];
  partners: MatchablePartner[];
  referenceOrgs: ReferenceOrg[];
  limit?: number;
}): PartnerRecommendation[] {
  const needles = buildNeedles(input.query, input.resultTitles.slice(0, 10));
  if (needles.size === 0) return [];
  const recs: PartnerRecommendation[] = [];

  // Roster partners: capability overlap, warm-relationship bonus.
  for (const p of input.partners) {
    if (p.status && p.status !== "active") continue;
    const hits = overlap(needles, p.capabilities);
    if (hits.length === 0) continue;
    recs.push({
      kind: "partner",
      id: p.id,
      name: p.name,
      score: 50 + hits.length * 15, // existing relationship is worth half the score
      reasons: [`Existing partner — warm path`, `Capabilities match: ${hits.slice(0, 3).join(", ")}`],
      focusAreas: hits,
      geography: null,
    });
  }

  // Reference orgs: focus-area overlap; funded orgs (winners/non-profits)
  // outrank foundations — they can PRIME a grant with Acme as the sub.
  for (const o of input.referenceOrgs) {
    const hits = overlap(needles, o.focusAreas);
    if (hits.length === 0) continue;
    const fundedBonus = o.kind === "private_foundation" ? 0 : 15;
    const moneySignal = o.amountUsd != null && o.amountUsd > 0;
    const reasons = [
      `Focus match: ${hits.slice(0, 3).join(", ")}`,
      o.kind === "private_foundation"
        ? "Funder — their grantees need delivery partners"
        : "Funded org — can prime with Acme as sub",
    ];
    if (moneySignal) reasons.push("Demonstrated funding history");
    if (o.geography) reasons.push(o.geography);
    recs.push({
      kind: "reference",
      id: o.id,
      name: o.name,
      score: hits.length * 18 + fundedBonus + (moneySignal ? 8 : 0),
      reasons,
      focusAreas: hits,
      geography: o.geography,
    });
  }

  return recs
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 6);
}
