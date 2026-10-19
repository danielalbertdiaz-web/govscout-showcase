import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listUnscoredItems, setItemScore } from "@/lib/scouts";
import { scoreOpportunity, scoutItemSummary } from "@/lib/scoring";

export const runtime = "nodejs";
// 50 items × ~2s/call = comfortably under the 5min ceiling on a self-hosted
// next start. Cap so a runaway batch can't peg the CLI.
export const maxDuration = 300;

type BatchBody = {
  cap?: number;
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body: BatchBody = await req.json().catch(() => ({}) as BatchBody);
  const cap = Math.min(Math.max(Number(body.cap ?? 50), 1), 50);
  const items = listUnscoredItems(session.email, cap);
  if (items.length === 0) {
    return Response.json({ scored: 0, attempted: 0, failed: 0, items: [] });
  }

  let scored = 0;
  let failed = 0;
  const updated: { id: string; score: number; rationale: string }[] = [];
  for (const item of items) {
    if (req.signal.aborted) break;
    try {
      const result = await scoreOpportunity(scoutItemSummary(item), {
        signal: req.signal,
        attribution: { userEmail: session.email, source: "scout-score-batch" },
      });
      if (!result) {
        failed += 1;
        continue;
      }
      const row = setItemScore(item.id, session.email, result.score, result.rationale);
      if (row) {
        scored += 1;
        updated.push({ id: item.id, score: result.score, rationale: result.rationale });
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return Response.json({
    scored,
    failed,
    attempted: items.length,
    items: updated,
  });
}
