// Item 5.2 — SAM.gov Opportunities v2 adapter.
//
// SPLIT: the PURE half (url builder, ptype mapping, response parsing, deadline
// extraction) is network- and env-free so it is exhaustively unit-testable. The
// IMPURE half (`samGovSource`) is a DARK SEAM — exactly like the Candid adapter
// in 4.5/5.1: it only goes live when `SAM_GOV_API_KEY` is set, and returns []
// otherwise. NOTHING here sends anything; it only discovers candidate notices.

import {
  type TeamingNotice,
  type TeamingNoticeType,
  type TeamingQuery,
  type TeamingSource,
  DEFAULT_TARGET_NAICS,
  DEFAULT_TEAMING_NOTICE_TYPES,
} from "./types";

export const SAM_OPPORTUNITIES_ENDPOINT = "https://api.sam.gov/opportunities/v2/search";

// SAM.gov "ptype" notice-type codes ⇄ our normalized TeamingNoticeType.
const PTYPE_BY_TYPE: Record<TeamingNoticeType, string> = {
  "Special Notice": "s",
  "Sources Sought": "r",
  Presolicitation: "p",
  Solicitation: "o",
  "Combined Synopsis/Solicitation": "k",
  Other: "o",
};

// SAM returns a long-form "type" string; normalize it to our enum.
export function normalizeNoticeType(raw: string | null | undefined): TeamingNoticeType {
  const t = (raw ?? "").trim().toLowerCase();
  if (t.includes("special notice")) return "Special Notice";
  if (t.includes("sources sought")) return "Sources Sought";
  if (t.includes("combined")) return "Combined Synopsis/Solicitation";
  if (t.includes("presolicitation") || t.includes("pre-solicitation")) return "Presolicitation";
  if (t.includes("solicitation")) return "Solicitation";
  return "Other";
}

// SAM wants MM/dd/yyyy. Pure, timezone-stable (operates on UTC fields).
export function formatSamDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export type SamSearchParams = {
  apiKey: string;
  naics: string[];
  noticeTypes: TeamingNoticeType[];
  postedFrom: string; // MM/dd/yyyy
  postedTo: string; // MM/dd/yyyy
  limit: number;
};

// Build the fully-qualified search URL. SAM only accepts ONE ptype + ONE ncode
// per call, so the caller fans out; this builds a single concrete request URL.
export function buildSamSearchUrl(
  params: Omit<SamSearchParams, "naics" | "noticeTypes"> & {
    naics?: string | null;
    ptype?: string | null;
  },
): string {
  const u = new URL(SAM_OPPORTUNITIES_ENDPOINT);
  u.searchParams.set("api_key", params.apiKey);
  u.searchParams.set("postedFrom", params.postedFrom);
  u.searchParams.set("postedTo", params.postedTo);
  u.searchParams.set("limit", String(Math.min(Math.max(params.limit, 1), 1000)));
  if (params.ptype) u.searchParams.set("ptype", params.ptype);
  if (params.naics) u.searchParams.set("ncode", params.naics);
  return u.toString();
}

export function ptypeFor(noticeType: TeamingNoticeType): string {
  return PTYPE_BY_TYPE[noticeType] ?? "o";
}

// --- Pure response parsing -------------------------------------------------

type SamRecord = {
  noticeId?: unknown;
  title?: unknown;
  fullParentPathName?: unknown;
  organizationName?: unknown;
  postedDate?: unknown;
  type?: unknown;
  naicsCode?: unknown;
  responseDeadLine?: unknown;
  typeOfSetAside?: unknown;
  typeOfSetAsideDescription?: unknown;
  uiLink?: unknown;
  description?: unknown;
};

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

// Pull the prime contractor out of a "X won, seeking subs" notice. SAM doesn't
// carry a structured "prime" field, so we sniff the title/description for the
// common "<name> has been awarded / seeking subcontractors" phrasings.
export function extractPrime(title: string | null, description: string | null): string | null {
  // Scan the description first, then the title, SEPARATELY — concatenating a
  // Title-Cased title onto the body lets the greedy capture swallow scope words
  // ("IT Systems Modernization Acme Corp"). Prime names are 1–4 capitalized words.
  const patterns = [
    /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:has been|was|is being)\s+awarded\b/,
    /\bawarded to\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\b/,
    /\b([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3}),?\s+(?:the\s+)?prime\b/i,
  ];
  for (const hay of [description ?? "", title ?? ""]) {
    if (!hay) continue;
    for (const re of patterns) {
      const m = hay.match(re);
      if (m) return m[1].trim().replace(/[,.]$/, "");
    }
  }
  return null;
}

// Parse a SAM.gov v2 search response body into normalized notices. Tolerant:
// non-object / missing array ⇒ []. A record with no noticeId is skipped.
export function parseSamResponse(body: unknown): TeamingNotice[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { opportunitiesData?: unknown }).opportunitiesData;
  if (!Array.isArray(data)) return [];
  const out: TeamingNotice[] = [];
  for (const raw of data as SamRecord[]) {
    const noticeId = str(raw.noticeId);
    if (!noticeId) continue;
    const title = str(raw.title) ?? "(untitled notice)";
    const description = str(raw.description);
    out.push({
      noticeId,
      title,
      agency: str(raw.fullParentPathName) ?? str(raw.organizationName),
      prime: extractPrime(title, description),
      noticeType: normalizeNoticeType(str(raw.type)),
      naics: str(raw.naicsCode),
      description,
      postedDate: str(raw.postedDate),
      responseDeadline: str(raw.responseDeadLine),
      setAside: str(raw.typeOfSetAsideDescription) ?? str(raw.typeOfSetAside),
      url: str(raw.uiLink),
      source: "sam_gov",
    });
  }
  return out;
}

// --- Impure dark seam ------------------------------------------------------

function samConfigured(): boolean {
  return Boolean(process.env.SAM_GOV_API_KEY?.trim());
}

async function fetchJson(url: string, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const samGovSource: TeamingSource = {
  id: "sam_gov",
  get available() {
    return samConfigured();
  },
  async fetch(query: TeamingQuery): Promise<TeamingNotice[]> {
    const apiKey = process.env.SAM_GOV_API_KEY?.trim();
    if (!apiKey) return []; // dark until a key is provisioned

    const naics = query.naics?.length ? query.naics : DEFAULT_TARGET_NAICS;
    const noticeTypes = query.noticeTypes?.length
      ? query.noticeTypes
      : DEFAULT_TEAMING_NOTICE_TYPES;
    const days = query.postedWithinDays ?? 14;
    const limit = query.limit ?? 50;

    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const postedFrom = formatSamDate(from);
    const postedTo = formatSamDate(to);

    // SAM accepts one ptype + one ncode per request, so fan out over the cross
    // product and merge. Bounded: notice types (2) × NAICS (~10) requests.
    const seen = new Set<string>();
    const merged: TeamingNotice[] = [];
    for (const nt of noticeTypes) {
      for (const code of naics) {
        const url = buildSamSearchUrl({
          apiKey,
          postedFrom,
          postedTo,
          limit,
          ptype: ptypeFor(nt),
          naics: code,
        });
        const body = await fetchJson(url);
        for (const notice of parseSamResponse(body)) {
          if (seen.has(notice.noticeId)) continue;
          seen.add(notice.noticeId);
          merged.push(notice);
          if (merged.length >= limit) return merged;
        }
      }
    }
    return merged;
  },
};
