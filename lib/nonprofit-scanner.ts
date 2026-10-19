// Item 4.5 — non-profit candidate scoring + ranking (PURE, no I/O).
//
// The source adapters (lib/nonprofit-sources) discover raw candidates; this
// module turns them into an explainable, ranked shortlist. It is intentionally
// free of fetch/db so it can be unit-tested deterministically. Signals:
//   - theme alignment (NTEE code -> grant theme, plus name/mission keyword hit)
//   - geography bias toward HOME_STATES (NJ/FL)
//   - proximity to a known reference winner / vetted non-profit (4.4 dataset)
//   - whether a budget/revenue figure is present (fundability signal)
//
// De-dupe: any candidate whose referenceDedupeKey is in `excludeKeys`
// (existing partners from 4.1 + imported contacts from 4.3 + already-
// dispositioned candidates) is dropped, so the scanner never re-surfaces an
// org we already track.

import type { NonprofitCandidate } from "./nonprofit-sources/types";
import type { GrantTheme } from "./ntee-themes";
import { themesForNtee, inferThemesFromText, THEME_LABELS } from "./ntee-themes";
import type { ReferenceOrg } from "./reference-orgs";
import { referenceDedupeKey } from "./reference-orgs";
import { HOME_STATES } from "./partner-fit";

// Disposition vocabulary for a persisted candidate. A re-scan refreshes scores
// but never overwrites a disposition the user has already set.
export const NONPROFIT_DISPOSITIONS = [
  "new",
  "already_contacted",
  "not_interested",
  "partnered",
] as const;
export type NonprofitDisposition = (typeof NONPROFIT_DISPOSITIONS)[number];
export function isNonprofitDisposition(s: unknown): s is NonprofitDisposition {
  return typeof s === "string" && (NONPROFIT_DISPOSITIONS as readonly string[]).includes(s);
}
export const NONPROFIT_DISPOSITION_LABELS: Record<NonprofitDisposition, string> = {
  new: "New",
  already_contacted: "Already contacted",
  not_interested: "Not interested",
  partnered: "Partnered",
};

// Score weights — sum of the maxima is 100.
export const NONPROFIT_SCORE_WEIGHTS = {
  theme: 50,
  geography: 20,
  reference: 20,
  budget: 10,
} as const;

export type ScoredNonprofit = NonprofitCandidate & {
  /** 0-100 relevance, higher = better fit for this opportunity. */
  relevanceScore: number;
  /** Grant themes inferred for this candidate (from NTEE + text). */
  themes: GrantTheme[];
  /** Stable de-dupe key (org:<cleaned name>). */
  dedupeKey: string;
  /** Human-readable justification, 2-3 lines. */
  reasons: string[];
};

export type ScoreContext = {
  /** Themes the opportunity is funding (drives theme-match scoring). */
  themes: GrantTheme[];
  /** Reference orgs (4.4) used for the "known winner/vetted" signal. */
  referenceOrgs?: ReferenceOrg[];
};

const HOME = new Set<string>(HOME_STATES as readonly string[]);

// Infer a candidate's themes from its NTEE code first (precise), then fall back
// to keyword inference over name + mission text.
export function candidateThemes(c: NonprofitCandidate): GrantTheme[] {
  const fromNtee = c.nteeCode ? themesForNtee(c.nteeCode) : [];
  if (fromNtee.length > 0) return fromNtee;
  const text = [c.name, c.missionSummary ?? ""].join(" ");
  return inferThemesFromText(text);
}

// Pure: score a single candidate against the opportunity context.
export function scoreNonprofitCandidate(
  c: NonprofitCandidate,
  ctx: ScoreContext,
): ScoredNonprofit {
  const themes = candidateThemes(c);
  const reasons: string[] = [];
  let score = 0;

  // 1) Theme alignment — strongest signal.
  const wanted = new Set(ctx.themes);
  const overlap = themes.filter((t) => wanted.has(t));
  if (ctx.themes.length === 0) {
    // No opportunity themes to match against: give partial credit for simply
    // having a classifiable theme so the row isn't zeroed out.
    if (themes.length > 0) {
      score += Math.round(NONPROFIT_SCORE_WEIGHTS.theme * 0.4);
      reasons.push(`Classified as ${themes.map((t) => THEME_LABELS[t]).join(", ")}.`);
    }
  } else if (overlap.length > 0) {
    // Full credit for any overlap, scaled slightly by how many themes line up.
    const frac = Math.min(1, 0.6 + 0.2 * overlap.length);
    score += Math.round(NONPROFIT_SCORE_WEIGHTS.theme * frac);
    reasons.push(
      `Theme match: ${overlap.map((t) => THEME_LABELS[t]).join(", ")}.`,
    );
  } else if (themes.length > 0) {
    reasons.push(
      `Adjacent focus (${themes.map((t) => THEME_LABELS[t]).join(", ")}) — not a direct theme match.`,
    );
  }

  // 2) Geography — bias toward the firm's home states.
  const state = (c.state ?? "").toUpperCase();
  if (HOME.has(state)) {
    score += NONPROFIT_SCORE_WEIGHTS.geography;
    reasons.push(`Based in ${state} (home-state priority).`);
  }

  // 3) Reference proximity — same org (or close) appears in the vetted 4.4 set.
  const key = referenceDedupeKey(c.name);
  const refMatch = (ctx.referenceOrgs ?? []).find(
    (r) => referenceDedupeKey(r.name) === key,
  );
  if (refMatch) {
    score += NONPROFIT_SCORE_WEIGHTS.reference;
    reasons.push(
      refMatch.kind === "google_org_winner"
        ? "Known Google.org grant winner — proven fundability."
        : "Already on the vetted reference list.",
    );
  }

  // 4) Budget present — a filed revenue figure signals an established org.
  if (typeof c.revenueUsd === "number" && c.revenueUsd > 0) {
    score += NONPROFIT_SCORE_WEIGHTS.budget;
    reasons.push(`Reported revenue ≈ $${Math.round(c.revenueUsd).toLocaleString("en-US")}.`);
  }

  if (reasons.length === 0) reasons.push("Discovered via non-profit scan; no strong signals yet.");

  return {
    ...c,
    relevanceScore: Math.max(0, Math.min(100, score)),
    themes,
    dedupeKey: key,
    reasons: reasons.slice(0, 3),
  };
}

export type RankNonprofitInput = {
  candidates: NonprofitCandidate[];
  themes: GrantTheme[];
  referenceOrgs?: ReferenceOrg[];
  /** Dedupe keys to suppress: partners (4.1) + contacts (4.3) + dispositioned. */
  excludeKeys?: Iterable<string>;
  limit?: number;
};

// Pure: score, de-dupe, and rank a batch of candidates. Highest score first;
// ties broken by presence of a budget figure, then name for stability.
export function rankNonprofitCandidates(input: RankNonprofitInput): ScoredNonprofit[] {
  const exclude = new Set(input.excludeKeys ?? []);
  const ctx: ScoreContext = { themes: input.themes, referenceOrgs: input.referenceOrgs };
  const seen = new Set<string>();
  const scored: ScoredNonprofit[] = [];
  for (const c of input.candidates) {
    const s = scoreNonprofitCandidate(c, ctx);
    if (exclude.has(s.dedupeKey)) continue; // already a partner/contact/handled
    if (seen.has(s.dedupeKey)) continue; // intra-batch dupe
    seen.add(s.dedupeKey);
    scored.push(s);
  }
  scored.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    const ab = a.revenueUsd ? 1 : 0;
    const bb = b.revenueUsd ? 1 : 0;
    if (bb !== ab) return bb - ab;
    return a.name.localeCompare(b.name);
  });
  return typeof input.limit === "number" ? scored.slice(0, input.limit) : scored;
}
