// P14 — search typo tolerance. grants.gov and SAM.gov do exact keyword
// matching: "opiod" returns 0 results while "opioid" returns 26 (found live,
// 2026-06-11). When a query whiffs, we suggest the nearest domain term and
// the search route retries with it — pure functions here, retry policy in
// the route (impure shell).

import { SCOUT_PROFILES } from "./scout-profiles";

// Domain vocabulary: every word from every profile keyword, plus grant-world
// terms an operator is likely to type. Lowercase, deduped at module init.
const EXTRA_TERMS = [
  "opioid", "fentanyl", "naloxone", "overdose", "stimulant", "methamphetamine",
  "grant", "grants", "funding", "cooperative", "agreement", "nofo",
  "rural", "urban", "county", "municipal", "tribal", "veteran", "veterans",
  "youth", "justice", "housing", "homeless", "homelessness", "workforce",
  "infrastructure", "broadband", "cybersecurity", "telehealth", "medicaid",
  "medicare", "samhsa", "hrsa", "marketing", "advertising", "outreach",
  "awareness", "prevention", "treatment", "recovery", "research", "evaluation",
  "technical", "assistance", "capacity", "building", "community", "coalition",
];

const VOCABULARY: string[] = Array.from(
  new Set(
    [
      ...SCOUT_PROFILES.flatMap((p) => p.keywords.flatMap((k) => k.split(/\s+/))),
      ...EXTRA_TERMS,
    ].map((w) => w.toLowerCase().replace(/[^a-z0-9()-]/g, "")),
  ),
).filter((w) => w.length >= 3);

/** Classic Levenshtein, early-exit when a row's minimum exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Returns a corrected query if any token looks like a typo of a domain term,
 * or null when the query is fine (or unsalvageable). Tokens shorter than 4
 * chars and exact vocabulary words pass through untouched.
 */
export function suggestCorrection(query: string): string | null {
  const tokens = query.trim().split(/\s+/);
  if (!tokens.length) return null;
  let changed = false;
  const corrected = tokens.map((raw) => {
    const word = raw.toLowerCase();
    if (word.length < 4 || VOCABULARY.includes(word)) return raw;
    const maxDist = word.length >= 7 ? 2 : 1;
    let best: string | null = null;
    let bestDist = maxDist + 1;
    for (const v of VOCABULARY) {
      const d = editDistance(word, v, maxDist);
      if (d < bestDist) {
        bestDist = d;
        best = v;
        if (d === 1) break;
      }
    }
    if (best && bestDist <= maxDist) {
      changed = true;
      return best;
    }
    return raw;
  });
  if (!changed) return null;
  const result = corrected.join(" ");
  return result.toLowerCase() === query.trim().toLowerCase() ? null : result;
}
