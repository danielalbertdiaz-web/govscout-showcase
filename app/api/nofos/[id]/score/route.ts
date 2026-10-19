import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getNofo, setNofoScore } from "@/lib/db";
import { scoreOpportunity, nofoSummary } from "@/lib/scoring";
import { tryAutoDraft } from "@/lib/auto-draft";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const nofo = getNofo(id, session.email);
  if (!nofo) return Response.json({ error: "not_found" }, { status: 404 });

  const result = await scoreOpportunity(nofoSummary(nofo), {
    signal: req.signal,
    attribution: { userEmail: session.email, source: "nofo-score" },
  });
  if (!result) {
    return Response.json({ error: "score_parse_failed" }, { status: 502 });
  }
  const updated = setNofoScore(id, session.email, result.score, result.rationale);
  if (!updated) return Response.json({ error: "write_failed" }, { status: 500 });

  const autoDraft = await tryAutoDraft({
    kind: "nofo",
    sourceId: id,
    score: result.score,
    userEmail: session.email,
  }).catch((err) => ({ outcome: "skipped" as const, reason: err instanceof Error ? err.message : "unknown_error", draftId: null, log: null }));

  return Response.json({ nofo: updated, autoDraft });
}
