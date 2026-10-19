// Item 4.2 — partner-fit ranking + pre-drafted intro for a saved opportunity.
//
//   GET  /api/opportunities/[id]/partner-fit[?draftId=...]
//        → { eligible, scoreGate, ranking } — ranks active partners by fit.
//          When `draftId` is supplied, the 4.1 include/exclude roster is honored.
//   POST /api/opportunities/[id]/partner-fit
//        body: { partnerId?: string }  (defaults to the #1-ranked partner)
//        → writes outreach/{rfp_id}/{partner}-intro.md and returns the draft.
//          NOTHING IS SENT — the file is a draft for the operator to review.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getSavedOpportunity, getDraftRoster, listOpportunityDispositions } from "@/lib/db";
import { loadPartners } from "@/lib/partners";
import { loadAllPartnerProfiles } from "@/lib/partner-profiles";
import {
  rankPartnerFit,
  sniffOpportunityStates,
  SCORE_GATE_0_100,
  type OpportunityContext,
} from "@/lib/partner-fit";
import { composePartnerIntro } from "@/lib/partner-intro";
import { writeIntroDraft, introDraftRelPath } from "@/lib/outreach-files";
import { includedPartnerIds } from "@/lib/draft-partners";

export const runtime = "nodejs";
export const maxDuration = 30;

// Build the pure ranking context for an opportunity, loading partner profiles
// and wiring in the 4.1 roster (when a draftId is given) + 3.1 win history.
async function buildRanking(
  oppId: string,
  userEmail: string,
  draftId: string | null,
) {
  const opp = getSavedOpportunity(oppId, userEmail);
  if (!opp) return null;

  const partners = await loadPartners(); // full Partner records (active only)
  const profiles = await loadAllPartnerProfiles(partners);

  // 3.1: count prior WON opportunities per partner so winners get a tailwind.
  const dispositionWins: Record<string, number> = {};
  for (const rec of listOpportunityDispositions(userEmail)) {
    if (rec.disposition !== "won" || !rec.dims.partner) continue;
    const key = rec.dims.partner.trim().toLowerCase();
    const match = profiles.find(
      (p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key,
    );
    if (match) dispositionWins[match.id] = (dispositionWins[match.id] ?? 0) + 1;
  }

  // 4.1: if this opportunity is tied to a draft with a curated roster, restrict
  // the ranking to its included partners. An empty/absent roster does NOT zero
  // the list — opportunity-level ranking falls back to all active partners.
  let includedIds: string[] | undefined;
  if (draftId) {
    const roster = getDraftRoster(draftId, userEmail);
    if (roster.length) includedIds = includedPartnerIds(roster);
  }

  const oppText = [opp.title, opp.summary, opp.eligibility, opp.agency]
    .filter(Boolean)
    .join("\n");
  const ctx: OpportunityContext = {
    text: oppText,
    states: sniffOpportunityStates(oppText),
    strategicScore: opp.strategicScore,
  };

  const ranking = rankPartnerFit({ profiles, opp: ctx, includedIds, dispositionWins });
  return { opp, ranking };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const draftId = req.nextUrl.searchParams.get("draftId");
  const built = await buildRanking(id, session.email, draftId);
  if (!built) return Response.json({ error: "not_found" }, { status: 404 });

  const eligible =
    built.opp.strategicScore != null && built.opp.strategicScore >= SCORE_GATE_0_100;
  return Response.json({
    eligible,
    scoreGate: SCORE_GATE_0_100,
    strategicScore: built.opp.strategicScore,
    ranking: built.ranking,
  });
}

type PostBody = { partnerId?: string };

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body: PostBody = await req.json().catch(() => ({}));

  const built = await buildRanking(id, session.email, null);
  if (!built) return Response.json({ error: "not_found" }, { status: 404 });

  // Default to the #1-ranked partner; allow an explicit override.
  const targetId = body.partnerId?.trim() || built.ranking.best?.id;
  if (!targetId) {
    return Response.json({ error: "no_partner_to_draft" }, { status: 400 });
  }
  const fit = built.ranking.ranked.find((r) => r.id === targetId);
  if (!fit) return Response.json({ error: "partner_not_ranked" }, { status: 400 });

  // Re-load the chosen partner's full profile for the intro body.
  const partners = await loadPartners([targetId]);
  const profiles = await loadAllPartnerProfiles(partners);
  const profile = profiles.find((p) => p.id === targetId);
  if (!profile) return Response.json({ error: "partner_not_found" }, { status: 404 });

  const intro = composePartnerIntro(
    profile,
    {
      id: built.opp.id,
      title: built.opp.title,
      agency: built.opp.agency,
      deadline: built.opp.deadline,
      summary: built.opp.summary,
    },
    fit,
  );

  // Persist as a DRAFT file — nothing is sent.
  const absPath = await writeIntroDraft(built.opp.id, targetId, intro.markdown);
  return Response.json({
    saved: true,
    sent: false, // explicit: this system never auto-sends
    path: introDraftRelPath(built.opp.id, targetId),
    absPath,
    fit,
    markdown: intro.markdown,
    redactions: intro.redactions,
    safe: intro.safe,
  });
}
