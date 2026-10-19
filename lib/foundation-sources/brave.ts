// N7 — Brave Search adapter for the foundation lane (free tier: 2,000
// queries/mo). Finds LIVE grant/RFP pages the curated foundation-pages list
// doesn't know about yet — the open-web complement to PND-RSS (announcements)
// and ProPublica (funder profiles). Dark seam: no BRAVE_SEARCH_API_KEY → the
// registry skips it.

import {
  FOUNDATION_FOCUS_KEYWORDS,
  grantMatchesKeywords,
  type FoundationGrant,
  type FoundationQuery,
  type FoundationSource,
} from "./types";

export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Targeted "find me an application page" queries — one search each, capped to
// stay miles inside the free tier even on a weekly cron (4 × 52 ≈ 208/yr).
export const BRAVE_FOUNDATION_QUERIES = [
  "New Jersey behavioral health foundation grant application",
  "Florida substance use disorder foundation funding opportunity",
  "opioid recovery nonprofit grant RFP 2026",
  "mental health foundation grant letter of inquiry New Jersey OR Florida",
];

export function braveConfigured(): boolean {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim());
}

type BraveResult = {
  title?: string;
  url?: string;
  description?: string;
  profile?: { name?: string };
  meta_url?: { hostname?: string };
};

/** Pure: hostname → a displayable funder name ("njhealthfoundation.org"). */
export function funderFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

// Domains that aggregate/list grants rather than fund them — keep the lane
// pointed at actual funders.
const AGGREGATOR_HOSTS = [
  "instrumentl.com",
  "grantwatch.com",
  "thegrantportal.com",
  "grantforward.com",
  "opengrants.io",
  "grantstation.com",
  "candid.org",
  "grants.gov",
  "linkedin.com",
  "facebook.com",
  "reddit.com",
];

export function isAggregator(url: string): boolean {
  const host = funderFromUrl(url).toLowerCase();
  return AGGREGATOR_HOSTS.some((a) => host === a || host.endsWith(`.${a}`));
}

/** Pure: map a Brave web-search payload to candidate FoundationGrant rows. */
export function parseBraveResults(body: unknown, sourceQuery: string): FoundationGrant[] {
  if (!body || typeof body !== "object") return [];
  const results = ((body as { web?: { results?: unknown } }).web?.results ?? []) as BraveResult[];
  if (!Array.isArray(results)) return [];
  const out: FoundationGrant[] = [];
  for (const r of results) {
    const url = (r.url ?? "").trim();
    const title = (r.title ?? "").trim();
    if (!url || !title || isAggregator(url)) continue;
    out.push({
      funder: r.profile?.name?.trim() || r.meta_url?.hostname?.replace(/^www\./, "") || funderFromUrl(url),
      title,
      url,
      summary: (r.description ?? "").trim() || `Found via web search: "${sourceQuery}"`,
      deadlineText: null,
      focusAreas: [],
      geography: null,
      fundingMin: null,
      fundingMax: null,
      applicationCycle: null,
      decisionTimeline: null,
      source: "brave_search",
    });
  }
  return out;
}

export const braveFoundationSource: FoundationSource = {
  id: "brave_search",
  get available() {
    return braveConfigured();
  },
  async fetch(query: FoundationQuery): Promise<FoundationGrant[]> {
    const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (!key) return [];
    const keywords = query.keywords?.length ? query.keywords : [...FOUNDATION_FOCUS_KEYWORDS];
    const limit = query.limit ?? 20;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const merged: FoundationGrant[] = [];
      const seen = new Set<string>();
      for (const q of BRAVE_FOUNDATION_QUERIES) {
        const u = new URL(BRAVE_SEARCH_ENDPOINT);
        u.searchParams.set("q", q);
        u.searchParams.set("count", "10");
        const res = await fetch(u, {
          signal: ctrl.signal,
          headers: { accept: "application/json", "x-subscription-token": key },
        });
        if (!res.ok) continue; // one bad query never sinks the scan
        for (const g of parseBraveResults(await res.json(), q)) {
          const k = g.url!.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          // Keep only results that actually smell like Acme's themes.
          if (!grantMatchesKeywords(g, keywords)) continue;
          merged.push(g);
          if (merged.length >= limit) return merged;
        }
      }
      return merged;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  },
};
