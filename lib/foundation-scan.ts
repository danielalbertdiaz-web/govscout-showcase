// Item 5.1 — foundation scan orchestrator.
//
// Thin glue: query the available foundation sources (PND-RSS + foundation-pages
// live; Candid seam when keyed), then ingest the merged grants into the scouts
// pipeline tagged source="foundation". Called by the weekly cron route and any
// manual "scan now" trigger. Nothing here sends anything — it only discovers
// and persists candidate grants for triage.

import { searchFoundationSources, FOUNDATION_FOCUS_KEYWORDS } from "./foundation-sources";
import type { FoundationQuery } from "./foundation-sources";
import { ingestFoundationGrants, type FoundationIngestResult } from "./scouts";

export type FoundationScanResult = FoundationIngestResult & {
  found: number;
};

// Run a foundation scan for one user. Defaults to Acme's SUD / behavioral-health /
// recovery focus keywords; pass a query to narrow/broaden.
export async function runFoundationScan(
  userEmail: string,
  query: FoundationQuery = {},
): Promise<FoundationScanResult> {
  const effective: FoundationQuery = {
    keywords: query.keywords ?? [...FOUNDATION_FOCUS_KEYWORDS],
    themes: query.themes,
    limit: query.limit ?? 50,
  };
  const { grants, sourcesUsed } = await searchFoundationSources(effective);
  const ingest = ingestFoundationGrants(userEmail, grants, { sourcesUsed });
  return { ...ingest, found: grants.length };
}
