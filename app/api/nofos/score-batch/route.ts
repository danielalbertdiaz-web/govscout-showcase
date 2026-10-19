import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listUnscoredNofos, setNofoScore } from "@/lib/db";
import { scoreOpportunity, nofoSummary } from "@/lib/scoring";
import { tryAutoDraft } from "@/lib/auto-draft";

export const runtime = "nodejs";
export const maxDuration = 300;

type BatchBody = { cap?: number };

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body: BatchBody = await req.json().catch(() => ({}) as BatchBody);
  const cap = Math.min(Math.max(Number(body.cap ?? 50), 1), 50);
  const nofos = listUnscoredNofos(session.email, cap);
  if (nofos.length === 0) {
    return Response.json({ scored: 0, attempted: 0, failed: 0, nofos: [] });
  }

  let scored = 0;
  let failed = 0;
  const updated: { id: string; score: number; rationale: string }[] = [];
  for (const nofo of nofos) {
    if (req.signal.aborted) break;
    try {
      const result = await scoreOpportunity(nofoSummary(nofo), {
        signal: req.signal,
        attribution: { userEmail: session.email, source: "nofo-score-batch" },
      });
      if (!result) {
        failed += 1;
        continue;
      }
      const row = setNofoScore(nofo.id, session.email, result.score, result.rationale);
      if (row) {
        scored += 1;
        updated.push({ id: nofo.id, score: result.score, rationale: result.rationale });
        // Sprint 7: auto-draft trigger. Best-effort — never let a trigger
        // failure abort the batch.
        try {
          await tryAutoDraft({
            kind: "nofo",
            sourceId: nofo.id,
            score: result.score,
            userEmail: session.email,
          });
        } catch {
          // swallowed
        }
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
    attempted: nofos.length,
    nofos: updated,
  });
}
