// Item 4.5 — ProPublica Nonprofit Explorer adapter (free, sits on IRS Form 990).
//
// The URL-builder and the JSON->candidate parser are PURE and unit-tested; the
// live `search` is a thin fetch shell around them so tests never hit the
// network. ProPublica's search endpoint returns name/EIN/city/state/ntee_code
// but not revenue — we optionally enrich the top-N via the per-org endpoint,
// bounded to keep the scan cheap. Geography is filtered by state[id].
//
// API docs: https://projects.propublica.org/nonprofits/api

import type { GrantTheme } from "../ntee-themes";
import { nteeCodesForTheme } from "../ntee-themes";
import type { NonprofitCandidate, NonprofitQuery, NonprofitSource } from "./types";

const BASE = "https://projects.propublica.org/nonprofits/api/v2";

// Build the human-facing query string for ProPublica's full-text search. We lean
// on free-text (theme keywords + a couple of representative NTEE codes) rather
// than ProPublica's coarse 1-10 ntee category, then re-classify precisely on the
// way back using our own NTEE map.
export function buildProPublicaQueryText(themes: GrantTheme[], extra?: string): string {
  const THEME_TERMS: Record<GrantTheme, string> = {
    substance_use: "substance use disorder treatment recovery",
    behavioral_health: "behavioral mental health",
    reentry: "reentry formerly incarcerated",
    youth: "youth development",
    crime_prevention: "violence prevention",
    health: "community health",
    human_services: "human services",
  };
  const terms = themes.map((t) => THEME_TERMS[t]).filter(Boolean);
  const text = (extra ?? "").trim();
  return [text, ...terms].filter(Boolean).join(" ").trim();
}

export function proPublicaSearchUrl(query: NonprofitQuery, page = 0): string {
  const params = new URLSearchParams();
  const q = buildProPublicaQueryText(query.themes, query.text);
  if (q) params.set("q", q);
  // ProPublica accepts a single state[id]; we issue one request per state and
  // merge upstream when more than one is requested.
  const state = query.states?.[0];
  if (state) params.set("state[id]", state.toUpperCase());
  if (page > 0) params.set("page", String(page));
  return `${BASE}/search.json?${params.toString()}`;
}

export function proPublicaOrgUrl(ein: string): string {
  const clean = ein.replace(/\D/g, "");
  return `${BASE}/organizations/${clean}.json`;
}

export function proPublicaPublicUrl(ein: string): string {
  const clean = ein.replace(/\D/g, "");
  return `https://projects.propublica.org/nonprofits/organizations/${clean}`;
}

type PPOrg = {
  ein?: number | string;
  name?: string;
  sub_name?: string;
  city?: string;
  state?: string;
  ntee_code?: string;
  raw_ntee_code?: string;
};

// Pure: turn a ProPublica search payload into normalized candidates.
export function parseProPublicaSearch(json: unknown): NonprofitCandidate[] {
  const orgs =
    json && typeof json === "object" && Array.isArray((json as { organizations?: unknown }).organizations)
      ? ((json as { organizations: PPOrg[] }).organizations)
      : [];
  const out: NonprofitCandidate[] = [];
  for (const o of orgs) {
    const name = (o.name ?? o.sub_name ?? "").trim();
    if (!name) continue;
    const ein = o.ein != null ? String(o.ein).replace(/\D/g, "") : null;
    out.push({
      ein: ein || null,
      name,
      nteeCode: (o.ntee_code ?? o.raw_ntee_code ?? null) || null,
      missionSummary: null, // search endpoint carries no mission text
      city: (o.city ?? null) || null,
      state: (o.state ?? null) || null,
      revenueUsd: null, // enriched separately, bounded
      source: "propublica",
      sourceUrl: ein ? proPublicaPublicUrl(ein) : null,
    });
  }
  return out;
}

// Pure: extract an approximate revenue figure from a ProPublica org payload
// (latest filing's total revenue / total functional expenses, whichever present).
export function parseProPublicaRevenue(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const filings = (json as { filings_with_data?: unknown }).filings_with_data;
  if (!Array.isArray(filings) || filings.length === 0) return null;
  // filings are typically newest-first; scan for the first usable revenue.
  for (const f of filings) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const rev = rec.totrevenue ?? rec.totfuncexpns ?? rec.totassetsend;
    if (typeof rev === "number" && Number.isFinite(rev) && rev > 0) return rev;
  }
  return null;
}

// --- live adapter (thin fetch shell) ---------------------------------------

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "GovScout/4.5 (research)" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// How many top candidates to enrich with a revenue lookup per scan (bounds the
// number of extra HTTP calls).
const ENRICH_LIMIT = 8;

export const propublicaSource: NonprofitSource = {
  id: "propublica",
  available: true, // free, no key required
  async search(query: NonprofitQuery): Promise<NonprofitCandidate[]> {
    const states = query.states && query.states.length > 0 ? query.states : [undefined];
    const seen = new Set<string>();
    const merged: NonprofitCandidate[] = [];
    for (const state of states) {
      const url = proPublicaSearchUrl({ ...query, states: state ? [state] : [] });
      const json = await fetchJson(url);
      for (const c of parseProPublicaSearch(json)) {
        const key = c.ein ?? c.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(c);
      }
    }
    const limit = query.limit ?? 25;
    const top = merged.slice(0, limit);
    // Bounded revenue enrichment for the first few candidates.
    await Promise.all(
      top.slice(0, ENRICH_LIMIT).map(async (c) => {
        if (!c.ein) return;
        const json = await fetchJson(proPublicaOrgUrl(c.ein));
        c.revenueUsd = parseProPublicaRevenue(json);
      }),
    );
    return top;
  },
};

// Re-export so the scanner can read the codes it will be querying for logging.
export { nteeCodesForTheme };
