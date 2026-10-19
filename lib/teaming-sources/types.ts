// Item 5.2 — subaward / teaming notices: shared types + NAICS targeting.
//
// A "teaming notice" is a government posting that signals a primecontract
// opportunity where small firms like Acme Consulting + TechPartners can join as
// SUBS rather than chase the prime — typically SAM.gov "Special Notice" and
// "Sources Sought" notices. This module is pure (no network, no env) so the
// targeting + matching logic is exhaustively testable.

export type TeamingNoticeType =
  | "Special Notice"
  | "Sources Sought"
  | "Combined Synopsis/Solicitation"
  | "Presolicitation"
  | "Solicitation"
  | "Other";

// A normalized teaming notice — what every source adapter must emit.
export type TeamingNotice = {
  /** Stable provider id (SAM.gov noticeId) — primary dedupe key. */
  noticeId: string;
  title: string;
  /** The prime/agency that posted (office or department). */
  agency: string | null;
  /** The prime contractor named in a "X won, seeking subs" notice, if any. */
  prime: string | null;
  noticeType: TeamingNoticeType;
  naics: string | null;
  /** Free-text scope/description (already plain text). */
  description: string | null;
  /** ISO-ish posted date string as the source provides it. */
  postedDate: string | null;
  /** "Respond by" deadline text — what a sub must hit to raise their hand. */
  responseDeadline: string | null;
  setAside: string | null;
  url: string | null;
  source: string;
};

export type TeamingQuery = {
  /** NAICS codes to filter on; empty ⇒ the default TARGET_NAICS set. */
  naics?: string[];
  /** Notice types to include; empty ⇒ Special Notice + Sources Sought. */
  noticeTypes?: TeamingNoticeType[];
  /** How many days back to look. */
  postedWithinDays?: number;
  limit?: number;
};

export interface TeamingSource {
  readonly id: string;
  /** True only when the source can actually run (e.g. an API key is present). */
  readonly available: boolean;
  fetch(query: TeamingQuery): Promise<TeamingNotice[]>;
}

// Acme Consulting + TechPartners' core NAICS, plus behavioral-health adjacents that
// fit the SUD practice. Each carries a human label for the /teaming UI.
export const TARGET_NAICS: Record<string, string> = {
  // Core consulting / IT / engineering capability.
  "541512": "Computer Systems Design Services",
  "541611": "Administrative & General Management Consulting",
  "541330": "Engineering Services",
  "541519": "Other Computer Related Services",
  "541618": "Other Management Consulting Services",
  // Behavioral-health adjacents (the SUD practice).
  "621330": "Offices of Mental Health Practitioners",
  "621420": "Outpatient Mental Health & Substance Abuse Centers",
  "623220": "Residential Mental Health & Substance Abuse Facilities",
  "624190": "Other Individual & Family Services",
  "541720": "R&D in the Social Sciences & Humanities",
};

// The subset that is behavioral-health-specific — used to bias scope-fit toward
// the SUD practice when a notice carries one of these codes.
export const BEHAVIORAL_HEALTH_NAICS = new Set([
  "621330",
  "621420",
  "623220",
  "624190",
  "541720",
]);

// The DEFAULT scan targets Acme's behavioral-health / SUD mission (operator
// decision 2026-06-08). SAM's fan-out early-returns once `limit` is hit, so
// listing engineering codes first starved the behavioral-health ones — making
// the defaults the behavioral-health set fixes that deterministically. The
// engineering/IT codes stay in TARGET_NAICS (UI labels + teaming-fit scoring)
// and can still be passed explicitly via TeamingQuery.naics for TechPartners' IT
// teaming, but are not auto-discovered by default.
export const DEFAULT_TARGET_NAICS = [...BEHAVIORAL_HEALTH_NAICS];

export const DEFAULT_TEAMING_NOTICE_TYPES: TeamingNoticeType[] = [
  "Special Notice",
  "Sources Sought",
];

// --- Triage disposition taxonomy -------------------------------------------
// Where a discovered teaming notice sits in the raise-a-hand funnel. Distinct
// from the scout/contact taxonomies because the verbs differ (we PURSUE a sub
// role, we don't "contact a notice").
export const TEAMING_DISPOSITIONS = [
  "new",
  "pursuing",
  "outreach_drafted",
  "passed",
  "teamed",
] as const;
export type TeamingDisposition = (typeof TEAMING_DISPOSITIONS)[number];

export function isTeamingDisposition(s: unknown): s is TeamingDisposition {
  return typeof s === "string" && (TEAMING_DISPOSITIONS as readonly string[]).includes(s);
}

export const TEAMING_DISPOSITION_LABELS: Record<TeamingDisposition, string> = {
  new: "New",
  pursuing: "Pursuing",
  outreach_drafted: "Outreach drafted",
  passed: "Passed",
  teamed: "Teamed",
};

/** True when a notice's NAICS is in the target set (empty target ⇒ matches all). */
export function naicsMatches(naics: string | null | undefined, target: string[]): boolean {
  if (target.length === 0) return true;
  if (!naics) return false;
  const code = naics.trim();
  return target.includes(code);
}

/** Human label for a NAICS code, or the bare code when unknown. */
export function naicsLabel(naics: string | null | undefined): string {
  if (!naics) return "—";
  return TARGET_NAICS[naics.trim()] ? `${naics} · ${TARGET_NAICS[naics.trim()]}` : naics;
}
