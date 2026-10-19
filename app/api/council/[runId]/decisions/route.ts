import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCouncilRun, getCouncilDecisionLog } from "@/lib/council";

export const dynamic = "force-dynamic";

/**
 * GET /api/council/[runId]/decisions - Append-only human decision audit trail
 * for a council run (P1-4). Read-only; ownership enforced via the draft owner.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { runId } = await params;

    // Confirm the run exists and is owned by the caller before exposing its log.
    const run = getCouncilRun(runId, session.email);
    if (!run) {
      return NextResponse.json({ error: "Council run not found" }, { status: 404 });
    }

    const decisions = getCouncilDecisionLog(runId, session.email);
    return NextResponse.json({ decisions });

  } catch (error) {
    console.error("Get council decision log error:", error);
    return NextResponse.json(
      { error: "Failed to get decision log" },
      { status: 500 }
    );
  }
}
