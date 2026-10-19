// Item 4.5 — non-profit source registry. The scanner asks for the available
// sources and merges their candidates. ProPublica (free) is always on; Candid
// only when provisioned. Adding a source is a one-line change here.

import type { NonprofitCandidate, NonprofitQuery, NonprofitSource } from "./types";
import { propublicaSource } from "./propublica";
import { candidSource } from "./candid";

export type { NonprofitCandidate, NonprofitQuery, NonprofitSource } from "./types";

const ALL_SOURCES: NonprofitSource[] = [propublicaSource, candidSource];

export function availableNonprofitSources(): NonprofitSource[] {
  return ALL_SOURCES.filter((s) => s.available);
}

// Query every available source and merge, de-duping by EIN (or name when no EIN).
// One source failing/returning [] never sinks the whole scan.
export async function searchNonprofitSources(
  query: NonprofitQuery,
): Promise<{ candidates: NonprofitCandidate[]; sourcesUsed: string[] }> {
  const sources = availableNonprofitSources();
  const results = await Promise.allSettled(sources.map((s) => s.search(query)));
  const seen = new Set<string>();
  const candidates: NonprofitCandidate[] = [];
  const sourcesUsed: string[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    sourcesUsed.push(sources[i].id);
    for (const c of r.value) {
      const key = c.ein ?? c.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(c);
    }
  });
  return { candidates, sourcesUsed };
}
