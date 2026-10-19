// Item 5.1 (PP-1) — ProPublica Nonprofit Explorer adapter for the FOUNDATION
// lane. Free, no API key (sits on public IRS Form 990 data) — the legitimate
// substitute for the paid Candid seam.
//
// ProPublica is strong for org-level FINANCIALS but does not expose open RFP
// deadlines, so this surfaces theme-aligned GRANTMAKERS as funder-prospect
// profiles (operator decision 2026-06-09): funder name, geography, an estimated
// annual-giving figure (private foundations must pay out ~5%/yr of assets), and
// a ProPublica link to research further. The deeper "who did they actually
// fund" intelligence comes from the IRS 990-PF bulk ingest (item IRS-1).
//
// Split: PURE url-builders + PURE tolerant parsers (unit-tested, network-free)
// and a thin impure `fetch` that issues one search per home state, keeps the
// grantmaker-looking orgs, and enriches the top few with an assets lookup.
//
// API docs: https://projects.propublica.org/nonprofits/api

import type { GrantTheme } from "../ntee-themes";
import { themesForNtee, THEME_LABELS } from "../ntee-themes";
import type { FoundationGrant, FoundationQuery, FoundationSource } from "./types";

const BASE = "https://projects.propublica.org/nonprofits/api/v2";

// Acme's home states — funder prospecting is geographically biased to NJ/FL.
export const FUNDER_HOME_STATES = ["NJ", "FL"] as const;

// Private foundations are required to distribute ~5% of net investment assets
// per year — a defensible estimate of annual giving capacity from 990 assets.
export const FOUNDATION_PAYOUT_RATE = 0.05;

// ProPublica's `q` behaves like an AND/name match, so a long concatenated query
// returns nothing. Each theme maps to a few SHORT phrases issued as separate
// searches and merged — that's what actually surfaces funders by name.
const THEME_PHRASES: Record<GrantTheme, string[]> = {
  substance_use: ["substance abuse", "addiction", "recovery"],
  behavioral_health: ["behavioral health", "mental health"],
  reentry: ["reentry"],
  youth: ["youth"],
  crime_prevention: ["violence prevention"],
  health: ["community health"],
  human_services: ["human services"],
};

// Build the LIST of short search phrases (theme phrases + any extra keywords),
// de-duplicated. Each becomes its own ProPublica search per state.
export function funderQueryPhrases(themes: GrantTheme[], keywords?: string[]): string[] {
  const phrases = themes.flatMap((t) => THEME_PHRASES[t] ?? []);
  const extra = (keywords ?? []).map((k) => k.trim()).filter(Boolean);
  return Array.from(new Set([...extra, ...phrases].map((p) => p.toLowerCase())));
}

export function proPublicaFunderSearchUrl(state: string, qText: string, page = 0): string {
  const params = new URLSearchParams();
  if (qText) params.set("q", qText);
  if (state) params.set("state[id]", state.toUpperCase());
  if (page > 0) params.set("page", String(page));
  return `${BASE}/search.json?${params.toString()}`;
}

export function proPublicaFunderOrgUrl(ein: string): string {
  return `${BASE}/organizations/${ein.replace(/\D/g, "")}.json`;
}

export function proPublicaFunderPublicUrl(ein: string): string {
  return `https://projects.propublica.org/nonprofits/organizations/${ein.replace(/\D/g, "")}`;
}

// Heuristic: is this org plausibly a GRANTMAKER (vs. a service provider)? A
// funder either carries a Philanthropy/Grantmaking NTEE (major group "T") or its
// name reads like a foundation/trust/fund. Keeps the lane funder-focused without
// an extra per-org fetch.
export function looksLikeGrantmaker(name: string, nteeCode: string | null | undefined): boolean {
  const code = (nteeCode ?? "").toUpperCase();
  if (code.startsWith("T")) return true; // Philanthropy, Voluntarism & Grantmaking
  return /\b(foundation|trust|fund|funds|endowment|charitable|philanthrop)\w*/i.test(name);
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

export type FunderStub = {
  ein: string | null;
  name: string;
  city: string | null;
  state: string | null;
  nteeCode: string | null;
};

// Pure: ProPublica search payload → grantmaker stubs (service providers dropped).
export function parseFunderSearch(json: unknown): FunderStub[] {
  const orgs =
    json && typeof json === "object" && Array.isArray((json as { organizations?: unknown }).organizations)
      ? (json as { organizations: PPOrg[] }).organizations
      : [];
  const out: FunderStub[] = [];
  for (const o of orgs) {
    const name = (o.name ?? o.sub_name ?? "").trim();
    if (!name) continue;
    const nteeCode = (o.ntee_code ?? o.raw_ntee_code ?? null) || null;
    if (!looksLikeGrantmaker(name, nteeCode)) continue;
    out.push({
      ein: o.ein != null ? String(o.ein).replace(/\D/g, "") || null : null,
      name,
      city: (o.city ?? null) || null,
      state: (o.state ?? null) || null,
      nteeCode,
    });
  }
  return out;
}

// Pure: latest usable total assets (end-of-year) from an org payload — drives the
// estimated annual-giving figure. Falls back to revenue if assets are absent.
export function parseFunderAssets(json: unknown): number | null {
  if (!json || typeof json !== "object") return null;
  const filings = (json as { filings_with_data?: unknown }).filings_with_data;
  if (!Array.isArray(filings)) return null;
  for (const f of filings) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const v = rec.totassetsend ?? rec.totrevenue ?? rec.totfuncexpns;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

const STATE_NAMES: Record<string, string> = { NJ: "New Jersey", FL: "Florida" };

// Pure: assemble a funder-prospect FoundationGrant from a stub (+ optional assets).
export function funderStubToGrant(stub: FunderStub, assetsUsd: number | null): FoundationGrant {
  const themes = themesForNtee(stub.nteeCode);
  const focusAreas = themes.map((t) => THEME_LABELS[t]);
  const stateLabel = stub.state ? STATE_NAMES[stub.state.toUpperCase()] ?? stub.state : null;

  const estGiving = assetsUsd != null ? Math.round(assetsUsd * FOUNDATION_PAYOUT_RATE) : null;
  const summaryParts = [
    `${stub.name} — grantmaking funder${stateLabel ? ` based in ${stateLabel}` : ""}.`,
  ];
  if (assetsUsd != null) {
    summaryParts.push(
      `Latest 990 assets ~${fmtMoney(assetsUsd)}; est. annual giving ~${fmtMoney(estGiving ?? 0)} ` +
        `(${Math.round(FOUNDATION_PAYOUT_RATE * 100)}% payout rule).`,
    );
  }
  summaryParts.push("Funder prospect — research giving history & approach directly.");

  return {
    funder: stub.name,
    title: `Funder prospect${stateLabel ? ` — ${stateLabel}` : ""} (grantmaking foundation)`,
    url: stub.ein ? proPublicaFunderPublicUrl(stub.ein) : null,
    summary: summaryParts.join(" "),
    deadlineText: null, // private foundations rarely post open deadlines
    focusAreas,
    geography: stateLabel,
    fundingMin: null,
    fundingMax: estGiving != null ? fmtMoney(estGiving) : null,
    applicationCycle: "Private foundation — typically by invitation / direct inquiry",
    decisionTimeline: null,
    source: "propublica",
  };
}

// --- impure live adapter ----------------------------------------------------

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "GovScout/5.1 (foundation research)" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Bound the per-scan assets enrichment (extra HTTP calls).
const ENRICH_LIMIT = 8;
const DEFAULT_THEMES: GrantTheme[] = ["substance_use", "behavioral_health"];

export const propublicaFoundationSource: FoundationSource = {
  id: "propublica",
  available: true, // free, no key
  async fetch(query: FoundationQuery): Promise<FoundationGrant[]> {
    const themes = query.themes?.length ? query.themes : DEFAULT_THEMES;
    const phrases = funderQueryPhrases(themes, query.keywords ? [...query.keywords] : undefined);
    const limit = query.limit ?? 25;

    // Fan out state × phrase, merging grantmaker stubs by EIN (or name).
    const seen = new Set<string>();
    const stubs: FunderStub[] = [];
    const requests = FUNDER_HOME_STATES.flatMap((state) =>
      phrases.map((phrase) => proPublicaFunderSearchUrl(state, phrase)),
    );
    const responses = await Promise.allSettled(requests.map((url) => fetchJson(url)));
    for (const r of responses) {
      if (r.status !== "fulfilled") continue;
      for (const s of parseFunderSearch(r.value)) {
        const key = s.ein ?? s.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        stubs.push(s);
      }
    }

    const top = stubs.slice(0, limit);
    const assetsByKey = new Map<string, number | null>();
    await Promise.all(
      top.slice(0, ENRICH_LIMIT).map(async (s) => {
        if (!s.ein) return;
        const json = await fetchJson(proPublicaFunderOrgUrl(s.ein));
        assetsByKey.set(s.ein, parseFunderAssets(json));
      }),
    );

    return top.map((s) => funderStubToGrant(s, s.ein ? assetsByKey.get(s.ein) ?? null : null));
  },
};
