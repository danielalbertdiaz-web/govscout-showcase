// Micro Contracts scanner — queries SAM.gov v2 for biddable federal contract
// opportunities (Combined Synopsis/Solicitation + Solicitation). Reuses the
// SAM.gov adapter's URL builder and response parser. NOTHING sends anything;
// this only discovers and persists candidate contracts for triage.

import {
  buildSamSearchUrl,
  formatSamDate,
  parseSamResponse,
  ptypeFor,
} from "./teaming-sources/sam-gov";
import type { TeamingNotice, TeamingNoticeType } from "./teaming-sources/types";
import { upsertMicroContract, listMicroContracts, type MicroContractRecord } from "./db";
import { normaliseSetAside, type SetAsideCanonical } from "./set-aside";
import { admitEligibility, type EligibilityExclusionReason } from "./scan-gates";

const NOTICE_DESC_ENDPOINT = "https://api.sam.gov/prod/opportunities/v1/noticedesc";

// Acme Consulting's core NAICS codes for direct contracting.
export const CONTRACT_NAICS = ["541611", "541512", "541519", "541715"];

// Notice types that represent actual biddable opportunities.
const CONTRACT_NOTICE_TYPES: TeamingNoticeType[] = [
  "Combined Synopsis/Solicitation",
  "Solicitation",
];

// Certification-required phrasings. Used only as a substring BACKSTOP for
// strings the normaliser cannot classify (e.g. "Sources Sought (may set aside
// WOSB)" is speculative -> canonical "unknown", but the WOSB mention still
// means Acme cannot bid it) — preserving exactly the exclusions the legacy
// substring gate enforced.
const EXCLUDED_SET_ASIDE_PHRASES = [
  "sdvosb",
  "service-disabled veteran",
  "wosb",
  "women-owned",
  "edwosb",
  "hubzone",
  "buy indian",
  "indian",
];

// Canonical set-aside programs that require certifications Acme does not hold.
const EXCLUDED_CANONICAL: ReadonlySet<SetAsideCanonical> = new Set([
  "sdvosb",
  "wosb",
  "edwosb",
  "hubzone",
  "isbee",
  "bicIv",
] satisfies SetAsideCanonical[]);

export type SetAsideAdmission = {
  admitted: boolean;
  /**
   * WHY the notice was admitted or skipped — the distinction the old gate
   * erased. "open" = the notice DECLARES no set-aside; "eligible" = a program
   * Acme can bid; "unclassified" = we could not classify the value (including
   * absent), collected for human triage — NOT a claim that it is open;
   * "excluded" = requires a certification Acme does not hold.
   */
  reason: "open" | "eligible" | "unclassified" | "excluded";
  canonical: SetAsideCanonical;
};

/**
 * DISCOVERY gate, not an eligibility ruling: it controls which SAM notices
 * are collected for triage, so it stays PERMISSIVE on the unknown side —
 * an unclassifiable set-aside is collected and marked "unclassified" rather
 * than assumed open (absent data is not a declaration; same cardinal rule as
 * lib/set-aside.ts). It is strict only on certification-required programs Acme
 * cannot bid under any reading. The verdict's `reason` (and, on persisted
 * rows, the set_aside_canonical column from migration 039) is how downstream
 * tells "genuinely open" apart from "we could not classify".
 *
 * 8(a) is deliberately ADMITTED: it always was (the legacy gate listed it
 * eligible), Acme's 8(a) application is pending SBA review (see the
 * acme-consulting-8a-status boilerplate block), and the Bid Board tracks an
 * "8(a) competitive" opportunity. Certification checks belong to the
 * bid/no-bid layer, not discovery.
 */
export function admitSetAside(setAside: string | null): SetAsideAdmission {
  const { canonical } = normaliseSetAside(setAside);
  if (EXCLUDED_CANONICAL.has(canonical)) {
    return { admitted: false, reason: "excluded", canonical };
  }
  if (canonical === "none") return { admitted: true, reason: "open", canonical };
  if (canonical === "small_business" || canonical === "8a") {
    return { admitted: true, reason: "eligible", canonical };
  }
  // canonical === "unknown": collect it for a human — unless the unclassified
  // string still names a certification-required program (the backstop).
  const lower = (setAside ?? "").toLowerCase();
  if (lower && EXCLUDED_SET_ASIDE_PHRASES.some((ex) => lower.includes(ex))) {
    return { admitted: false, reason: "excluded", canonical };
  }
  return { admitted: true, reason: "unclassified", canonical };
}

async function fetchJson(url: string, timeoutMs = 12000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNoticeDescription(
  noticeId: string,
  apiKey: string,
): Promise<string | null> {
  const url = `${NOTICE_DESC_ENDPOINT}?noticeid=${encodeURIComponent(noticeId)}&api_key=${encodeURIComponent(apiKey)}`;
  const body = await fetchJson(url, 15000);
  if (!body || typeof body !== "object") return null;
  const desc = (body as Record<string, unknown>).description;
  if (typeof desc === "string" && desc.trim()) return desc.trim();
  const data = (body as Record<string, unknown>).data;
  if (typeof data === "string" && data.trim()) return data.trim();
  return null;
}

export type MicroContractScanResult = {
  available: boolean;
  found: number;
  persisted: number;
  newCount: number;
  /** Notices matching a permanent-delete tombstone (migration 036) — nothing written. */
  skippedDeleted: number;
  /**
   * Tier 1 eligibility exclusions (lib/scan-gates.ts): sole-source/brand-name
   * citations and reseller-only clauses, matched in the notice text at
   * discovery — BEFORE the scanning agent ever reasons about or scores the
   * notice. Excluded notices are never staged, so they can never receive an
   * AI-deliverability verdict; they are reported here, with the matched
   * evidence, rather than silently dropped (the foreign-PoP lesson).
   */
  excludedIneligible: Array<{
    noticeId: string;
    title: string;
    reason: EligibilityExclusionReason;
    evidence: string;
  }>;
};

export async function runMicroContractScan(
  userEmail: string,
  opts: { postedWithinDays?: number; limit?: number } = {},
): Promise<MicroContractScanResult> {
  const apiKey = process.env.SAM_GOV_API_KEY?.trim();
  if (!apiKey) {
    return { available: false, found: 0, persisted: 0, newCount: 0, skippedDeleted: 0, excludedIneligible: [] };
  }

  const days = opts.postedWithinDays ?? 30;
  const limit = opts.limit ?? 100;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const postedFrom = formatSamDate(from);
  const postedTo = formatSamDate(to);

  const seen = new Set<string>();
  const notices: TeamingNotice[] = [];
  const excludedIneligible: MicroContractScanResult["excludedIneligible"] = [];

  for (const nt of CONTRACT_NOTICE_TYPES) {
    for (const code of CONTRACT_NAICS) {
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
        // Discovery gate: skip only certification-required programs. Admitted
        // rows carry the admission distinction durably — upsertMicroContract
        // stamps set_aside_canonical (039), so "genuinely open" (none) and
        // "could not classify" (unknown) stay distinguishable downstream.
        if (!admitSetAside(notice.setAside).admitted) continue;
        // Tier 1 eligibility gate (SCANNER_SCORING_DEFECT_PACKET): a positive
        // sole-source/brand-name or reseller-only match in the notice text
        // excludes it HERE, before staging — so the scoring agent never sees
        // it and it can never receive a "100/100" verdict (FD2399-26-00126
        // carried its FAR 16.505(a)(4)(i) citation in the notice text and
        // still scored 75/100). Positive matches only: an unclassifiable
        // notice is admitted, mirroring admitSetAside — and the exclusion is
        // reported in the scan result, never silently dropped.
        const elig = admitEligibility([notice.title, notice.description].filter(Boolean).join("\n"));
        if (!elig.admitted) {
          excludedIneligible.push({
            noticeId: notice.noticeId,
            title: notice.title,
            reason: elig.reason,
            evidence: elig.evidence,
          });
          continue;
        }
        notices.push(notice);
        if (notices.length >= limit) break;
      }
      if (notices.length >= limit) break;
    }
    if (notices.length >= limit) break;
  }

  let persisted = 0;
  let newCount = 0;
  let skippedDeleted = 0;
  for (const n of notices) {
    const result = upsertMicroContract({
      userEmail,
      noticeId: n.noticeId,
      solNumber: null,
      title: n.title,
      agency: n.agency,
      noticeType: n.noticeType,
      naics: n.naics,
      description: n.description,
      postedDate: n.postedDate,
      responseDeadline: n.responseDeadline,
      setAside: n.setAside,
      url: n.url ?? `https://sam.gov/opp/${n.noticeId}/view`,
    });
    if (result.skippedDeleted) {
      // Permanently deleted (migration 036): the upsert wrote NOTHING — count
      // the skip separately so a tombstoned notice never inflates `persisted`.
      skippedDeleted++;
      continue;
    }
    persisted++;
    if (result.created) newCount++;
  }

  return { available: true, found: notices.length, persisted, newCount, skippedDeleted, excludedIneligible };
}

export function listActiveContracts(userEmail: string): MicroContractRecord[] {
  return listMicroContracts(userEmail);
}
