// Item 5.1 — foundation source registry. The weekly scan asks for the available
// sources and merges their grants. PND-RSS + foundation-pages (free) are always
// on; Candid only when provisioned. Adding a source is a one-line change here.
//
// ≥3 sources integrated per the brief: pnd_rss, foundation_pages, candid (seam).

import type { FoundationGrant, FoundationQuery, FoundationSource } from "./types";
import { pndRssSource } from "./pnd-rss";
import { foundationPagesSource } from "./foundation-pages";
import { propublicaFoundationSource } from "./propublica";
import { braveFoundationSource } from "./brave";
import { candidFoundationSource } from "./candid";

export type { FoundationGrant, FoundationQuery, FoundationSource } from "./types";
export { FOUNDATION_FOCUS_KEYWORDS, grantMatchesKeywords } from "./types";

const ALL_SOURCES: FoundationSource[] = [
  pndRssSource,
  foundationPagesSource,
  propublicaFoundationSource, // free, no key — funder-prospect profiles (PP-1)
  braveFoundationSource, // free tier — live grant/RFP pages from the open web (N7)
  candidFoundationSource,
];

export function availableFoundationSources(): FoundationSource[] {
  return ALL_SOURCES.filter((s) => s.available);
}

// Stable de-dupe key for a grant: prefer the URL, else funder+title.
export function foundationGrantKey(g: FoundationGrant): string {
  const url = g.url?.trim().toLowerCase();
  if (url) return `url:${url}`;
  return `ft:${g.funder.toLowerCase()}|${g.title.toLowerCase()}`;
}

// Query every available source and merge, de-duping by URL (or funder+title).
// One source failing/returning [] never sinks the whole scan.
export async function searchFoundationSources(
  query: FoundationQuery,
): Promise<{ grants: FoundationGrant[]; sourcesUsed: string[] }> {
  const sources = availableFoundationSources();
  const results = await Promise.allSettled(sources.map((s) => s.fetch(query)));
  const seen = new Set<string>();
  const grants: FoundationGrant[] = [];
  const sourcesUsed: string[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    sourcesUsed.push(sources[i].id);
    for (const g of r.value) {
      const key = foundationGrantKey(g);
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push(g);
    }
  });
  return { grants, sourcesUsed };
}
