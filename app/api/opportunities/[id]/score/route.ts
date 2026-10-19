// POST /api/opportunities/[id]/score
// Runs the strategic fit scoring algorithm on a saved opportunity and
// persists the result. Returns the updated opportunity record.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getSavedOpportunity, setOpportunityStrategicScore } from "@/lib/db";
import { computeStrategicScore, type OpportunityInput } from "@/lib/strategic-scoring";
import { tryAutoDraft } from "@/lib/auto-draft";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) return Response.json({ error: "not_found" }, { status: 404 });

  const input: OpportunityInput = {
    title: opp.title,
    agency: opp.agency,
    deadline: opp.deadline,
    eligibility: opp.eligibility,
    summary: opp.summary,
    naics: opp.naics,
  };

  const result = computeStrategicScore(input);

  const detail: Record<string, unknown> = {
    recommendation: result.recommendation,
    criteria: result.criteria,
    summary: result.summary,
  };

  const updated = setOpportunityStrategicScore(id, session.email, result.score, detail);
  if (!updated) return Response.json({ error: "update_failed" }, { status: 500 });

  const autoDraft = await tryAutoDraft({
    kind: "saved_opportunity",
    sourceId: id,
    score: result.score,
    userEmail: session.email,
  }).catch((err) => ({ outcome: "skipped" as const, reason: err instanceof Error ? err.message : "unknown_error", draftId: null, log: null }));

  return Response.json({ opportunity: updated, scoring: result, autoDraft });
}
