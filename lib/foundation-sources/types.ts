// Item 5.1 — foundation grant data-source adapter contract.
//
// Mirrors the 4.5 non-profit adapter shape. The "foundation lane" does NOT get
// a separate UI: discovered grants flow into the existing scouts pipeline tagged
// source="foundation" (see lib/foundation-scan.ts). Each source is an adapter so
// adding/removing one is a one-line registry change, and the paid Candid source
// is a dark seam that shares the 4.5 cost decision ("don't pay twice").

import type { GrantTheme } from "../ntee-themes";

// A discovered foundation grant / RFP, normalized across sources. Carries the
// foundation PROFILE fields the brief asks for (avg grant size via funding
// range, geographic restrictions, focus areas, application cycle, decision
// timeline) so the downstream pipeline keeps them.
export type FoundationGrant = {
  /** Foundation / funder name, e.g. "Robert Wood Johnson Foundation". */
  funder: string;
  /** Program / RFP title. */
  title: string;
  url: string | null;
  summary: string | null;
  deadlineText: string | null;
  focusAreas: string[];
  /** Geographic restriction text, e.g. "New Jersey only" / "National". */
  geography: string | null;
  /** Typical/min grant size as a display string (e.g. "$50,000"). */
  fundingMin: string | null;
  fundingMax: string | null;
  /** Application cadence, e.g. "Annual call" / "Rolling" / "Invitation-only". */
  applicationCycle: string | null;
  /** Time from submission to award decision, when known. */
  decisionTimeline: string | null;
  /** Which adapter produced this row — auditability. */
  source: string;
};

export type FoundationQuery = {
  /** Grant themes to bias toward (SUD / behavioral health / recovery). */
  themes?: GrantTheme[];
  /** Extra free-text keywords to match (case-insensitive substring). */
  keywords?: string[];
  limit?: number;
};

export interface FoundationSource {
  readonly id: string;
  /** Whether this source is configured and usable right now. */
  readonly available: boolean;
  fetch(query: FoundationQuery): Promise<FoundationGrant[]>;
}

// Default keyword set for Acme's foundation focus: substance use / behavioral
// health / recovery. Used by adapters to filter free-text feeds.
export const FOUNDATION_FOCUS_KEYWORDS = [
  "substance use",
  "substance abuse",
  "opioid",
  "addiction",
  "recovery",
  "behavioral health",
  "mental health",
  "overdose",
  "prevention",
  "reentry",
  "harm reduction",
] as const;

// Pure: does a grant's text match any of the focus keywords? Empty keyword list
// means "no filter" (match everything).
export function grantMatchesKeywords(
  grant: Pick<FoundationGrant, "title" | "summary" | "focusAreas">,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return true;
  const hay = [grant.title, grant.summary ?? "", grant.focusAreas.join(" ")]
    .join(" ")
    .toLowerCase();
  return keywords.some((k) => hay.includes(k.toLowerCase()));
}
