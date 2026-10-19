import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCouncilRun, recordHumanDecision } from "@/lib/council";

export const dynamic = "force-dynamic";

/**
 * GET /api/council/[runId] - Get council run status and results
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
    const councilRun = getCouncilRun(runId, session.email);

    if (!councilRun) {
      return NextResponse.json({ error: "Council run not found" }, { status: 404 });
    }

    return NextResponse.json(councilRun);

  } catch (error) {
    console.error("Get council run error:", error);
    return NextResponse.json(
      { error: "Failed to get council run" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/council/[runId] - Update council run (for human decisions)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { runId } = await params;
    const body = await req.json();
    const { human_decision, checklist_ack } = body;

    if (!["submit", "needs_more_review", "reject"].includes(human_decision)) {
      return NextResponse.json(
        { error: "human_decision must be 'submit', 'needs_more_review', or 'reject'" },
        { status: 400 }
      );
    }

    const result = recordHumanDecision(runId, human_decision, session.email, {
      checklistAck: checklist_ack === true,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.code });
    }

    return NextResponse.json(result.run);

  } catch (error) {
    console.error("Update council run error:", error);
    return NextResponse.json(
      { error: "Failed to update council run" },
      { status: 500 }
    );
  }
}