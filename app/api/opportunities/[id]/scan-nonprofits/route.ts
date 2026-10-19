// Item 4.5 — non-profit partner-discovery scanner for a saved opportunity.
//
//   GET  /api/opportunities/[id]/scan-nonprofits
//        → { candidates, themes } — the persisted, ranked shortlist.
//   POST /api/opportunities/[id]/scan-nonprofits   body: { limit?: number }
//        → runs a fresh scan (ProPublica/IRS-990 live; Candid seam when keyed),
//          ranks, persists. Re-scan PRESERVES dispositions on triaged rows.
//
// De-dupe: candidates already on the partner roster (4.1), in the contact book
// (4.3), or previously triaged here are dropped from the fresh ranking.
// NOTHING is sent — this only discovers and stores candidate leads.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getSavedOpportunity,
  listContacts,
  listNonprofitCandidates,
  upsertNonprofitCandidate,
} from "@/lib/db";
import { listPartners } from "@/lib/partners";
import { loadReferenceData } from "@/lib/reference-data";
import { searchNonprofitSources } from "@/lib/nonprofit-sources";
import { inferThemesFromText } from "@/lib/ntee-themes";
import { sniffOpportunityStates, HOME_STATES } from "@/lib/partner-fit";
import { referenceDedupeKey } from "@/lib/reference-orgs";
import { rankNonprofitCandidates } from "@/lib/nonprofit-scanner";

export const runtime = "nodejs";
export const maxDuration = 60;

// Themes + geography + free-text for the source query, derived from the opp.
function opportunityScanContext(opp: {
  title: string;
  summary: string | null;
  eligibility: string | null;
  agency: string | null;
}) {
  const text = [opp.title, opp.summary, opp.eligibility, opp.agency]
    .filter(Boolean)
    .join("\n");
  const themes = inferThemesFromText(text);
  const sniffed = sniffOpportunityStates(text);
  // Bias to home states (NJ/FL) when the opportunity doesn't name a state.
  const states = sniffed.length ? sniffed : [...HOME_STATES];
  return { text, themes, states };
}

// Keys we never want to re-surface: existing partners, existing contacts, and
// candidates already triaged (disposition != "new") for this opportunity.
function buildExcludeKeys(
  userEmail: string,
  opportunityId: string,
  partnerNames: string[],
): Set<string> {
  const keys = new Set<string>();
  for (const n of partnerNames) keys.add(referenceDedupeKey(n));
  for (const c of listContacts(userEmail, { limit: 500 })) keys.add(referenceDedupeKey(c.name));
  for (const c of listNonprofitCandidates(opportunityId, userEmail)) {
    if (c.disposition !== "new") keys.add(c.dedupeKey);
  }
  return keys;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) return Response.json({ error: "not_found" }, { status: 404 });

  const { themes } = opportunityScanContext(opp);
  return Response.json({
    candidates: listNonprofitCandidates(id, session.email),
    themes,
  });
}

type ScanBody = { limit?: number };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) return Response.json({ error: "not_found" }, { status: 404 });

  const body: ScanBody = await req.json().catch(() => ({}));
  const limit = Math.min(Math.max(body.limit ?? 25, 1), 50);

  const { text, themes, states } = opportunityScanContext(opp);
  if (themes.length === 0) {
    return Response.json(
      {
        error: "no_theme",
        message:
          "Could not infer a grant theme from this opportunity — scan skipped. Add detail to the title/summary and retry.",
        candidates: listNonprofitCandidates(id, session.email),
        themes,
      },
      { status: 422 },
    );
  }

  // Discover (free ProPublica/IRS-990 live; Candid seam stays dark until keyed).
  const { candidates, sourcesUsed } = await searchNonprofitSources({
    themes,
    states,
    text,
    limit,
  });

  // Rank against the firm's reference winners (4.4) and suppress known orgs.
  const reference = await loadReferenceData();
  const partners = await listPartners();
  const excludeKeys = buildExcludeKeys(session.email, id, partners.map((p) => p.name));
  const ranked = rankNonprofitCandidates({
    candidates,
    themes,
    referenceOrgs: reference.orgs,
    excludeKeys,
    limit,
  });

  // Persist (upsert preserves disposition + promoted link on re-scan).
  for (const c of ranked) {
    upsertNonprofitCandidate({
      userEmail: session.email,
      opportunityId: id,
      ein: c.ein,
      name: c.name,
      nteeCode: c.nteeCode,
      state: c.state,
      source: c.source,
      sourceUrl: c.sourceUrl,
      revenueUsd: c.revenueUsd,
      relevanceScore: c.relevanceScore,
      reasons: c.reasons,
      themes: c.themes,
      dedupeKey: c.dedupeKey,
    });
  }

  return Response.json({
    scanned: true,
    sent: false, // explicit: this system never auto-sends
    sourcesUsed,
    themes,
    states,
    found: candidates.length,
    ranked: ranked.length,
    candidates: listNonprofitCandidates(id, session.email),
  });
}
