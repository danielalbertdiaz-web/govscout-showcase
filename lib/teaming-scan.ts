// Item 5.2 — teaming-scan orchestrator (impure shell).
//
// Ties the pure pieces together: build a teaming CONTEXT from the user's known
// relationships (partners 4.1 + contacts 4.3) and Acme/TechPartners' capabilities,
// run the source registry (SAM.gov dark seam today), score + rank each notice,
// and upsert into teaming_notices. A re-scan refreshes scores but preserves the
// operator's disposition + saved drafts (see upsertTeamingNotice). NOTHING sends.

import { listPartners } from "./partners";
import { listContacts, upsertTeamingNotice } from "./db";
import { loadReferenceData } from "./reference-data";
import {
  searchTeamingSources,
  availableTeamingSources,
  DEFAULT_TARGET_NAICS,
  DEFAULT_TEAMING_NOTICE_TYPES,
  type TeamingQuery,
} from "./teaming-sources/index";
import { rankTeamingNotices, type TeamingContext } from "./teaming-fit";

// Acme Consulting + TechPartners' standing capability vocabulary — the floor used
// when partner profiles are sparse. Tunable; documented, not buried.
export const EL_TEAMING_CAPABILITIES = [
  "substance use",
  "behavioral health",
  "mental health",
  "recovery",
  "case management",
  "program management",
  "management consulting",
  "technical assistance",
  "grant management",
  "systems integration",
  "software",
  "data analytics",
  "it modernization",
];

function uniqLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// Build the teaming context: who we already know (primes) + what we can field.
// "Known" spans partners, contacts' orgs, AND the Reference library (B4) — a
// notice whose prime we've already profiled is the warmest cold call there is.
export async function buildTeamingContext(userEmail: string): Promise<TeamingContext> {
  const partners = await listPartners();
  const contacts = listContacts(userEmail, {});
  let referenceNames: string[] = [];
  try {
    referenceNames = (await loadReferenceData()).orgs.map((o) => o.name);
  } catch {
    /* reference dataset is optional context — never blocks a scan */
  }
  const knownPrimeNames = uniqLower([
    ...partners.map((p) => p.name),
    ...contacts.map((c) => c.agency ?? ""),
    ...referenceNames,
  ]);
  const capabilityKeywords = uniqLower([
    ...EL_TEAMING_CAPABILITIES,
    ...partners.flatMap((p) => p.capabilities ?? []),
  ]);
  return { capabilityKeywords, knownPrimeNames, targetNaics: DEFAULT_TARGET_NAICS };
}

export type TeamingScanResult = {
  available: boolean; // false when no source is configured (SAM key missing)
  found: number; // raw notices discovered
  persisted: number; // rows upserted
  sourcesUsed: string[];
};

export async function runTeamingScan(
  userEmail: string,
  query: TeamingQuery = {},
): Promise<TeamingScanResult> {
  const q: TeamingQuery = {
    naics: DEFAULT_TARGET_NAICS,
    noticeTypes: DEFAULT_TEAMING_NOTICE_TYPES,
    postedWithinDays: 14,
    limit: 50,
    ...query,
  };

  const available = availableTeamingSources().length > 0;
  const { notices, sourcesUsed } = await searchTeamingSources(q);
  const ctx = await buildTeamingContext(userEmail);
  const ranked = rankTeamingNotices({ notices, ctx });

  let persisted = 0;
  for (const { notice, fit } of ranked) {
    upsertTeamingNotice({
      userEmail,
      noticeId: notice.noticeId,
      title: notice.title,
      agency: notice.agency,
      prime: notice.prime,
      noticeType: notice.noticeType,
      naics: notice.naics,
      description: notice.description,
      postedDate: notice.postedDate,
      responseDeadline: notice.responseDeadline,
      setAside: notice.setAside,
      url: notice.url,
      source: notice.source,
      fitScore: fit.fitScore,
      reasons: fit.reasons,
      knownPrime: fit.knownPrime,
    });
    persisted += 1;
  }

  return { available, found: notices.length, persisted, sourcesUsed };
}
