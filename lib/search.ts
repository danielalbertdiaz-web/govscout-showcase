import fs from "fs";
import path from "path";
import os from "os";

export type SearchSource = "govscout" | "grants_gov" | "sam_gov";

export type SearchResult = {
  source: SearchSource;
  sourceId: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  fundingFloor: string | null;
  fundingCeiling: string | null;
  eligibility: string | null;
  url: string | null;
  nofoUrl: string | null;
  summary: string | null;
  naics: string | null;
  raw: Record<string, unknown> | null;
};

export type SearchFilters = {
  q?: string;
  agency?: string;
  naics?: string;
  fundingFloorMin?: number;
  fundingCeilingMax?: number;
  deadlineFrom?: string;
  deadlineTo?: string;
  status?: "open" | "closed" | "all";
  source?: SearchSource | "all";
  rows?: number;
};

const GRANTS_GOV_SEARCH_URL = "https://api.grants.gov/v1/api/search2";
const SAM_GOV_SEARCH_URL = "https://api.sam.gov/opportunities/v2/search";

type GrantsGovOppHit = {
  id?: string | number;
  number?: string;
  title?: string;
  agencyCode?: string;
  agency?: string;
  agencyName?: string;
  openDate?: string;
  closeDate?: string;
  oppStatus?: string;
  docType?: string;
  alnist?: string[];
  cfdaList?: string[];
};

type GrantsGovSearchResponse = {
  errorcode?: number;
  msg?: string;
  data?: {
    hitCount?: number;
    oppHits?: GrantsGovOppHit[];
  };
};

export async function searchGrantsGov(filters: SearchFilters): Promise<SearchResult[]> {
  const rows = filters.rows ?? 25;
  const body: Record<string, unknown> = {
    rows,
    keyword: filters.q ?? "",
    oppStatuses: filters.status === "closed" ? "closed" : "forecasted|posted",
    sortBy: "openDate|desc",
  };
  if (filters.agency) body.agencies = filters.agency;
  if (filters.naics) {
    const codes = filters.naics
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (codes.length) body.naicsCodes = codes.join("|");
  }

  const res = await fetch(GRANTS_GOV_SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`grants.gov search failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as GrantsGovSearchResponse;
  if (data.errorcode && data.errorcode !== 0) {
    throw new Error(`grants.gov error: ${data.msg ?? "unknown"}`);
  }
  const hits = data.data?.oppHits ?? [];
  return hits.map((h): SearchResult => {
    const id = h.number ?? String(h.id ?? "");
    return {
      source: "grants_gov",
      sourceId: id,
      title: h.title ?? "(untitled)",
      agency: h.agencyName ?? h.agency ?? h.agencyCode ?? null,
      deadline: normalizeGrantsGovDate(h.closeDate) ?? null,
      fundingFloor: null,
      fundingCeiling: null,
      eligibility: null,
      url: id ? `https://www.grants.gov/search-results-detail/${h.id ?? ""}` : null,
      nofoUrl: null,
      summary: h.docType ?? null,
      naics: null,
      raw: h as unknown as Record<string, unknown>,
    };
  });
}

function normalizeGrantsGovDate(raw?: string): string | null {
  if (!raw) return null;
  // grants.gov returns "MMDDYYYY" sometimes, sometimes "YYYY-MM-DD".
  if (/^\d{8}$/.test(raw)) {
    const m = raw.slice(0, 2);
    const d = raw.slice(2, 4);
    const y = raw.slice(4, 8);
    return `${y}-${m}-${d}`;
  }
  return raw;
}

type SamGovOppHit = {
  noticeId?: string;
  title?: string;
  fullParentPathName?: string;
  type?: string;
  postedDate?: string;
  responseDeadLine?: string;
  naicsCode?: string;
  uiLink?: string;
  description?: string;
  award?: { amount?: string };
};

type SamGovSearchResponse = {
  totalRecords?: number;
  opportunitiesData?: SamGovOppHit[];
  error?: { message?: string };
};

export async function searchSamGov(filters: SearchFilters, apiKey: string): Promise<SearchResult[]> {
  const rows = Math.min(filters.rows ?? 25, 100);
  const today = new Date();
  const ninetyDaysAgo = new Date(today.getTime() - 90 * 86400_000);
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(rows),
    postedFrom: fmt(filters.deadlineFrom ? new Date(filters.deadlineFrom) : ninetyDaysAgo),
    postedTo: fmt(today),
  });
  if (filters.q) params.set("title", filters.q);
  if (filters.naics) {
    const first = filters.naics.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) params.set("ncode", first);
  }

  const res = await fetch(`${SAM_GOV_SEARCH_URL}?${params.toString()}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`SAM.gov search failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as SamGovSearchResponse;
  if (data.error?.message) {
    throw new Error(`SAM.gov error: ${data.error.message}`);
  }
  const hits = data.opportunitiesData ?? [];
  return hits.map((h): SearchResult => ({
    source: "sam_gov",
    sourceId: h.noticeId ?? String(Math.random()),
    title: h.title ?? "(untitled)",
    agency: h.fullParentPathName ?? null,
    deadline: h.responseDeadLine ?? null,
    fundingFloor: null,
    fundingCeiling: h.award?.amount ?? null,
    eligibility: null,
    url: h.uiLink ?? null,
    nofoUrl: null,
    summary: h.description ?? h.type ?? null,
    naics: h.naicsCode ?? null,
    raw: h as unknown as Record<string, unknown>,
  }));
}

const GOVSCOUT_DIGEST_PATHS = [
  // Honor explicit override.
  process.env.GOVSCOUT_DIGEST_GLOB,
  // Default location: openclaw cron run logs (jobs that mention "Gov Scout").
  path.join(os.homedir(), ".openclaw", "cron", "runs"),
].filter(Boolean) as string[];

export type GovScoutDigest = {
  jobId: string;
  runAtMs: number;
  summary: string;
  source: "cron-run-log";
};

export function readLatestGovScoutDigests(limit = 3): GovScoutDigest[] {
  const out: GovScoutDigest[] = [];
  for (const p of GOVSCOUT_DIGEST_PATHS) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isDirectory()) continue;
      const files = fs.readdirSync(p).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const full = path.join(p, f);
        const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
        for (let i = lines.length - 1; i >= 0 && out.length < limit * 4; i--) {
          try {
            const ev = JSON.parse(lines[i]) as {
              action?: string;
              status?: string;
              summary?: string;
              jobId?: string;
              runAtMs?: number;
            };
            if (ev.action !== "finished" || ev.status !== "ok") continue;
            const summary = ev.summary ?? "";
            if (!isLikelyGovScoutDigest(summary)) continue;
            out.push({
              jobId: ev.jobId ?? f.replace(/\.jsonl$/, ""),
              runAtMs: ev.runAtMs ?? 0,
              summary,
              source: "cron-run-log",
            });
          } catch {
            /* skip malformed line */
          }
        }
      }
    } catch {
      /* path missing or unreadable — skip */
    }
  }
  return out
    .sort((a, b) => b.runAtMs - a.runAtMs)
    .filter((d, i, arr) => arr.findIndex((x) => x.jobId === d.jobId && x.runAtMs === d.runAtMs) === i)
    .slice(0, limit);
}

function isLikelyGovScoutDigest(summary: string): boolean {
  if (!summary) return false;
  const s = summary.toLowerCase();
  return (
    s.includes("gov scout") ||
    s.includes("govscout") ||
    s.includes("daily digest") ||
    (s.includes("hrsa") && s.includes("samhsa")) ||
    (s.includes("naics") && s.includes("federal"))
  );
}
