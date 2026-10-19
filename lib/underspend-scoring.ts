/**
 * Underspend ranking model — the "search model that ranks unallocated funding."
 *
 * Pure, network-free, fully unit-tested. Given a discovered `UnderspendRecord`
 * and an Acme context, produce a 0-100 priority score with human-readable
 * reasons. The signal a grant-shaping shop cares about is NOT just "big pool" —
 * it's "big pool, mostly unspent, in our backyard, on our theme, about to
 * lapse." Five weighted components capture exactly that:
 *
 *   magnitude          .30  log-scaled absolute unspent $ (a $50M gap beats $200K)
 *   underutilization   .25  fraction left unspent (98% unspent = motivated funder)
 *   geographyFit       .20  NJ/FL home turf, then named-state, then federal/other
 *   thematicFit        .15  SUD / behavioral-health / recovery keyword hits
 *   urgency            .10  funds lapsing soon = use-it-or-lose-it pressure
 *
 * Mirrors partner-fit (4.2) / teaming-fit (5.2): 0-1 components → weighted
 * composite → top reasons. No LLM, no network — deterministic and testable.
 */

import {
  formatMoneyShort,
  pctUnspent,
  type UnderspendRecord,
} from "./underspend-sources/types";

export const UNDERSPEND_WEIGHTS = {
  magnitude: 0.3,
  underutilization: 0.25,
  geographyFit: 0.2,
  thematicFit: 0.15,
  urgency: 0.1,
} as const;

export const UNDERSPEND_THRESHOLD = 35;

export const EL_HOME_STATES = ["NJ", "FL"] as const;

export const DEFAULT_UNDERSPEND_KEYWORDS = [
  "substance use",
  "substance abuse",
  "opioid",
  "overdose",
  "recovery",
  "behavioral health",
  "mental health",
  "addiction",
  "prevention",
  "harm reduction",
  "treatment",
  "sud",
];

/**
 * CONDITIONAL keywords are ambiguous on their own: "recovery" matches SUD
 * recovery but ALSO disaster / Recovery-Act / ecological "recovery" (Hurricane
 * Education Recovery, Pacific Salmon Recovery, Cybersecurity Recovery Fund). A
 * conditional term only counts as a theme hit when a CORE substance/behavioral
 * term co-occurs in the same record — so it sharpens, never widens, the net.
 * (Operator decision 2026-06-08, from the live back-test.)
 */
export const CONDITIONAL_UNDERSPEND_KEYWORDS = new Set(["recovery"]);

function isCoreKeyword(keyword: string): boolean {
  return !CONDITIONAL_UNDERSPEND_KEYWORDS.has(keyword.toLowerCase());
}

export type UnderspendContext = {
  keywords: string[];
  homeStates: string[];
  /** "today" injectable for deterministic urgency tests */
  now?: number;
};

export type UnderspendComponents = {
  magnitude: number;
  underutilization: number;
  geographyFit: number;
  thematicFit: number;
  urgency: number;
};

export type UnderspendScore = {
  score: number; // 0-100
  reasons: string[];
  components: UnderspendComponents;
  /** Has at least one QUALIFYING theme hit (conditional terms need a core term). */
  onTheme: boolean;
};

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

// $250K → ~0.3, $1M → ~0.5, $10M → ~0.75, $100M+ → ~1.0
function magnitudeScore(unspent: number): number {
  if (unspent <= 0) return 0;
  const logged = Math.log10(unspent); // 5.4 @ 250K, 6 @ 1M, 8 @ 100M
  return Math.max(0, Math.min(1, (logged - 5) / 3.2));
}

function geographyScore(jurisdiction: string | null, homeStates: string[]): {
  value: number;
  reason: string | null;
} {
  const j = norm(jurisdiction);
  const stateNames: Record<string, string[]> = {
    NJ: ["nj", "new jersey"],
    FL: ["fl", "florida"],
  };
  for (const st of homeStates) {
    const needles = stateNames[st] ?? [st.toLowerCase()];
    if (needles.some((n) => j.includes(n))) {
      return { value: 1, reason: `Home-state pool (${st})` };
    }
  }
  // A specific (non-home) state still beats a diffuse federal pool for targeting.
  if (j && j !== "federal") return { value: 0.6, reason: null };
  if (j === "federal") return { value: 0.45, reason: null };
  return { value: 0.3, reason: null };
}

function thematicScore(record: UnderspendRecord, keywords: string[]): {
  value: number;
  hits: string[];
  onTheme: boolean;
} {
  const hay = `${norm(record.name)} ${norm(record.agency)} ${norm(record.program)}`;
  const allHits = keywords.filter((k) => hay.includes(k.toLowerCase()));
  const hasCore = allHits.some(isCoreKeyword);
  // A conditional term (e.g. "recovery") only qualifies alongside a core term;
  // a record matching ONLY conditional terms is off-theme (qualifyingHits = []).
  const qualifyingHits = hasCore ? allHits : [];
  // 0 qualifying hits → 0.2 floor (don't zero out a huge pool just for missing a
  // keyword), scaling up with each match.
  const value =
    qualifyingHits.length === 0 ? 0.2 : Math.min(1, 0.5 + qualifyingHits.length * 0.18);
  return { value, hits: qualifyingHits, onTheme: qualifyingHits.length > 0 };
}

function urgencyScore(periodEnd: string | null, now: number): { value: number; reason: string | null } {
  if (!periodEnd) return { value: 0.4, reason: null };
  const end = Date.parse(periodEnd);
  if (!Number.isFinite(end)) return { value: 0.4, reason: null };
  const days = (end - now) / 86_400_000;
  if (days < 0) return { value: 0.1, reason: "Period already lapsed" };
  if (days <= 90) return { value: 1, reason: "Funds lapse within 90 days" };
  if (days <= 180) return { value: 0.8, reason: "Funds lapse within 6 months" };
  if (days <= 365) return { value: 0.6, reason: null };
  return { value: 0.4, reason: null };
}

export function scoreUnderspend(
  record: UnderspendRecord,
  ctx: UnderspendContext,
  weights = UNDERSPEND_WEIGHTS,
): UnderspendScore {
  const now = ctx.now ?? Date.now();

  const magnitude = magnitudeScore(record.unspent);
  const underutilization = pctUnspent(record);
  const geo = geographyScore(record.jurisdiction, ctx.homeStates);
  const theme = thematicScore(record, ctx.keywords);
  const urg = urgencyScore(record.periodEnd, now);

  const components: UnderspendComponents = {
    magnitude,
    underutilization,
    geographyFit: geo.value,
    thematicFit: theme.value,
    urgency: urg.value,
  };

  const composite =
    components.magnitude * weights.magnitude +
    components.underutilization * weights.underutilization +
    components.geographyFit * weights.geographyFit +
    components.thematicFit * weights.thematicFit +
    components.urgency * weights.urgency;
  const score = Math.round(Math.max(0, Math.min(1, composite)) * 100);

  const reasons: string[] = [];
  reasons.push(`${formatMoneyShort(record.unspent)} unspent (${Math.round(underutilization * 100)}% of pool)`);
  if (geo.reason) reasons.push(geo.reason);
  if (theme.hits.length > 0) reasons.push(`Theme match: ${theme.hits.slice(0, 3).join(", ")}`);
  if (urg.reason) reasons.push(urg.reason);
  if (record.agency) reasons.push(record.agency);

  return { score, reasons: reasons.slice(0, 4), components, onTheme: theme.onTheme };
}

export type RankUnderspendInput = {
  records: UnderspendRecord[];
  ctx: UnderspendContext;
  weights?: typeof UNDERSPEND_WEIGHTS;
  limit?: number;
};

export type RankedUnderspend = {
  record: UnderspendRecord;
  score: number;
  reasons: string[];
  onTheme: boolean;
};

export function rankUnderspend(input: RankUnderspendInput): RankedUnderspend[] {
  const { records, ctx } = input;
  const weights = input.weights ?? UNDERSPEND_WEIGHTS;
  const scored = records.map((record) => {
    const s = scoreUnderspend(record, ctx, weights);
    return { record, score: s.score, reasons: s.reasons, onTheme: s.onTheme };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.record.unspent !== a.record.unspent) return b.record.unspent - a.record.unspent;
    return a.record.name.localeCompare(b.record.name);
  });
  const limit = input.limit ?? scored.length;
  return scored.slice(0, Math.max(0, limit));
}

/**
 * The persist gate: a ranked pool earns a slot in `/pools` only if it BOTH
 * clears the score threshold AND is genuinely on-theme. Keeping this pure (vs.
 * inlining `x.score >= T` in the scan) lets the conditional-keyword policy be
 * unit-tested without a DB and keeps the rule in one place for every caller.
 */
export function isPersistableUnderspend(
  ranked: RankedUnderspend,
  threshold = UNDERSPEND_THRESHOLD,
): boolean {
  return ranked.score >= threshold && ranked.onTheme;
}
