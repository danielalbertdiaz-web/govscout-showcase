// POST /api/opportunities/score-batch
// Runs strategic scoring + compliance checks on all saved opportunities that
// have not yet been strategically scored. Rule-based (no model call), so
// this runs fast and can be called freely.
// Body: { cap?: number }  defaults to 100, max 500.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  listSavedOpportunities,
  setOpportunityStrategicScore,
  setOpportunityComplianceResult,
} from "@/lib/db";
import { computeStrategicScore } from "@/lib/strategic-scoring";
import { runComplianceChecks } from "@/lib/compliance";
import { tryAutoDraft } from "@/lib/auto-draft";

export const runtime = "nodejs";

type BatchBody = { cap?: number };

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body: BatchBody = await req.json().catch(() => ({}) as BatchBody);
  const cap = Math.min(Math.max(Number(body.cap ?? 100), 1), 500);

  const all = listSavedOpportunities(session.email, cap);
  // Only process those that haven't been strategically scored yet.
  const unscored = all.filter((o) => o.strategicScore == null);

  let scored = 0;
  let failed = 0;
  const updated: { id: string; strategicScore: number; recommendation: string; complianceStatus: string }[] = [];

  for (const opp of unscored) {
    try {
      const scoreResult = computeStrategicScore({
        title: opp.title,
        agency: opp.agency,
        deadline: opp.deadline,
        eligibility: opp.eligibility,
        summary: opp.summary,
        naics: opp.naics,
      });

      const complianceResult = runComplianceChecks({
        title: opp.title,
        agency: opp.agency,
        deadline: opp.deadline,
        eligibility: opp.eligibility,
        summary: opp.summary,
      });

      const detail: Record<string, unknown> = {
        recommendation: scoreResult.recommendation,
        criteria: scoreResult.criteria,
        summary: scoreResult.summary,
      };

      setOpportunityStrategicScore(opp.id, session.email, scoreResult.score, detail);
      setOpportunityComplianceResult(
        opp.id,
        session.email,
        complianceResult.status,
        complianceResult.checks as unknown as Record<string, unknown>[],
      );

      scored += 1;
      updated.push({
        id: opp.id,
        strategicScore: scoreResult.score,
        recommendation: scoreResult.recommendation,
        complianceStatus: complianceResult.status,
      });
      // Sprint 7: auto-draft trigger. Best-effort.
      try {
        await tryAutoDraft({
          kind: "saved_opportunity",
          sourceId: opp.id,
          score: scoreResult.score,
          userEmail: session.email,
        });
      } catch {
        // swallowed
      }
    } catch {
      failed += 1;
    }
  }

  return Response.json({
    scored,
    failed,
    attempted: unscored.length,
    skipped: all.length - unscored.length,
    items: updated,
  });
}
