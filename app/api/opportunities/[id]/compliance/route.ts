// POST /api/opportunities/[id]/compliance
// Runs automated compliance checks on a saved opportunity and persists the
// result. Returns the updated opportunity record.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getSavedOpportunity, setOpportunityComplianceResult } from "@/lib/db";
import { runComplianceChecks, type ComplianceInput } from "@/lib/compliance";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) return Response.json({ error: "not_found" }, { status: 404 });

  const input: ComplianceInput = {
    title: opp.title,
    agency: opp.agency,
    deadline: opp.deadline,
    eligibility: opp.eligibility,
    summary: opp.summary,
  };

  const result = runComplianceChecks(input);

  const updated = setOpportunityComplianceResult(
    id,
    session.email,
    result.status,
    result.checks as unknown as Record<string, unknown>[],
  );
  if (!updated) return Response.json({ error: "update_failed" }, { status: 500 });

  return Response.json({ opportunity: updated, compliance: result });
}
