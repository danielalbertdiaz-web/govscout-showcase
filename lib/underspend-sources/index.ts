/**
 * Underspend source registry — fan out across sources, de-dupe, return a flat
 * list of candidate balances. Mirrors the foundation/teaming registries:
 * `Promise.allSettled` so one slow/broken source never sinks the scan.
 */

import { usaspendingSource } from "./usaspending";
import type { UnderspendQuery, UnderspendRecord, UnderspendSource } from "./types";

export * from "./types";

// Add paid/enrichment sources here behind their own `available` getters.
export const ALL_UNDERSPEND_SOURCES: UnderspendSource[] = [usaspendingSource];

export function availableUnderspendSources(): UnderspendSource[] {
  return ALL_UNDERSPEND_SOURCES.filter((s) => s.available);
}

/** Stable cross-source dedup key: recordId → url → name+agency. */
export function underspendKey(r: UnderspendRecord): string {
  if (r.recordId) return `id:${r.recordId.toLowerCase()}`;
  if (r.url) return `url:${r.url.toLowerCase()}`;
  return `na:${r.name.toLowerCase()}|${(r.agency ?? "").toLowerCase()}`;
}

export type UnderspendSearchResult = {
  records: UnderspendRecord[];
  sourcesUsed: string[];
};

export async function searchUnderspendSources(
  query: UnderspendQuery,
): Promise<UnderspendSearchResult> {
  const sources = availableUnderspendSources();
  const settled = await Promise.allSettled(sources.map((s) => s.search(query)));

  const seen = new Set<string>();
  const records: UnderspendRecord[] = [];
  const sourcesUsed: string[] = [];

  settled.forEach((res, i) => {
    if (res.status !== "fulfilled") return;
    sourcesUsed.push(sources[i].id);
    for (const r of res.value) {
      if (query.minUnspent != null && r.unspent < query.minUnspent) continue;
      const k = underspendKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      records.push(r);
    }
  });

  return { records, sourcesUsed };
}
