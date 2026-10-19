import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getItem, setItemScore } from "@/lib/scouts";
import { scoreOpportunity, scoutItemSummary } from "@/lib/scoring";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const item = getItem(id, session.email);
  if (!item) return Response.json({ error: "not_found" }, { status: 404 });

  const result = await scoreOpportunity(scoutItemSummary(item), {
    signal: req.signal,
    attribution: { userEmail: session.email, source: "scout-score" },
  });
  if (!result) {
    return Response.json({ error: "score_parse_failed" }, { status: 502 });
  }
  const updated = setItemScore(id, session.email, result.score, result.rationale);
  if (!updated) return Response.json({ error: "write_failed" }, { status: 500 });
  return Response.json({ item: updated });
}
