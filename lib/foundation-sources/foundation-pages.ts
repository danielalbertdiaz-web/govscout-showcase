// Item 5.1 — individual foundation funding-page registry (free, curated).
//
// A deterministic source that emits the standing open-call page for each
// foundation Acme actively maps, carrying the PROFILE data the brief asks for
// (funding range, geographic restriction, focus areas, application cycle,
// decision timeline). No scraping — these are stable, human-verified funder
// pages. The weekly cron re-emits them so they stay in the foundation lane even
// when PND has nothing new; the scouts pipeline de-dupes by title+url, so
// re-emitting is idempotent.
//
// This complements the manually-curated `foundations` PROFILE library
// (lib/foundations.ts); here the same funders are surfaced as pipeline-bound
// GRANT candidates so they flow through triage/scoring like everything else.

import type { FoundationGrant, FoundationQuery, FoundationSource } from "./types";
import { FOUNDATION_FOCUS_KEYWORDS, grantMatchesKeywords } from "./types";

// Curated foundation pages with full profile metadata. Geography-biased to NJ/FL
// + national funders with strong SUD / behavioral-health programs.
export const FOUNDATION_PAGES: FoundationGrant[] = [
  {
    funder: "Robert Wood Johnson Foundation",
    title: "RWJF — Healthy Communities & Behavioral Health (open calls)",
    url: "https://www.rwjf.org/en/grants/active-funding-opportunities.html",
    summary:
      "Health equity, behavioral health, and community resilience programs. HQ in Princeton, NJ with strong NJ regional preference.",
    deadlineText: "Rolling — varies by program",
    focusAreas: ["health equity", "behavioral health", "community resilience"],
    geography: "National (NJ-friendly)",
    fundingMin: "$50,000",
    fundingMax: "$2,500,000",
    applicationCycle: "Rolling; Pioneering Ideas RFP runs annually",
    decisionTimeline: "3–6 months typical",
    source: "foundation_pages",
  },
  {
    funder: "Conrad N. Hilton Foundation",
    title: "Conrad Hilton — Substance Use Prevention",
    url: "https://www.hiltonfoundation.org/programs/substance-use-prevention",
    summary:
      "SUD prevention in youth and family-based treatment models. Largely invitation-only and relationship-first.",
    deadlineText: "Invitation-only — relationship-first",
    focusAreas: ["substance use", "prevention", "youth", "family treatment"],
    geography: "National",
    fundingMin: "$250,000",
    fundingMax: "$5,000,000",
    applicationCycle: "Invitation-only",
    decisionTimeline: "6–12 months",
    source: "foundation_pages",
  },
  {
    funder: "Kresge Foundation",
    title: "Kresge — Human Services + Health",
    url: "https://kresge.org/our-work/health/",
    summary:
      "Health equity, human-services integration, and racial/economic justice. National reach with city-focused work; NJ cities eligible.",
    deadlineText: "Multiple RFPs per year",
    focusAreas: ["health equity", "human services", "behavioral health"],
    geography: "National (city-focused)",
    fundingMin: "$100,000",
    fundingMax: "$1,500,000",
    applicationCycle: "Multiple RFPs per year",
    decisionTimeline: "4–8 months",
    source: "foundation_pages",
  },
  {
    funder: "Bloomberg Philanthropies",
    title: "Bloomberg — American Cities & Public Health (opioid response)",
    url: "https://www.bloomberg.org/public-health/",
    summary:
      "Local-government innovation, public health, and opioid/overdose response. American Cities + Public Health initiatives both live.",
    deadlineText: "Cycle-based",
    focusAreas: ["opioid", "overdose", "public health", "local government"],
    geography: "US cities",
    fundingMin: "$100,000",
    fundingMax: "$10,000,000",
    applicationCycle: "Cycle-based",
    decisionTimeline: "Varies by initiative",
    source: "foundation_pages",
  },
  {
    funder: "New Jersey Health Initiatives",
    title: "NJ Health Initiatives — Community Health (NJ only)",
    url: "https://www.njhi.org/",
    summary:
      "RWJF's NJ-only arm. Community health, equity, youth, and food security. Smaller checks but a NJ-only moat with fewer national competitors.",
    deadlineText: "Annual calls",
    focusAreas: ["community health", "behavioral health", "youth", "equity"],
    geography: "New Jersey only",
    fundingMin: "$25,000",
    fundingMax: "$300,000",
    applicationCycle: "Annual call",
    decisionTimeline: "2–4 months",
    source: "foundation_pages",
  },
];

// Pure: filter the registry to the focus keywords for this query.
export function foundationPagesFor(query: FoundationQuery): FoundationGrant[] {
  const keywords = query.keywords ?? [...FOUNDATION_FOCUS_KEYWORDS];
  const matched = FOUNDATION_PAGES.filter((g) => grantMatchesKeywords(g, keywords));
  return typeof query.limit === "number" ? matched.slice(0, query.limit) : matched;
}

export const foundationPagesSource: FoundationSource = {
  id: "foundation_pages",
  available: true, // curated, no key or network required
  async fetch(query: FoundationQuery): Promise<FoundationGrant[]> {
    return foundationPagesFor(query);
  },
};
