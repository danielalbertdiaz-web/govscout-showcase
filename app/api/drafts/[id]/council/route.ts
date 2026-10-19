import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCouncilRunsForDraft, runCouncilDeliberation, shouldAutoTriggerCouncil } from "@/lib/council";
import { getDraft } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/drafts/[id]/council - Get all council runs for a draft
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const councilRuns = getCouncilRunsForDraft(id, session.email);

    // Check if this draft should auto-trigger
    const draft = getDraft(id, session.email);
    const shouldAutoTrigger = draft ? shouldAutoTriggerCouncil(draft) : false;

    return NextResponse.json({
      council_runs: councilRuns,
      should_auto_trigger: shouldAutoTrigger,
      latest_run: councilRuns[0] || null
    });

  } catch (error) {
    console.error("Get draft council runs error:", error);
    return NextResponse.json(
      { error: "Failed to get council runs" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/drafts/[id]/council - Start a new council run for this draft
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();
    const { trigger_type = "manual" } = body;

    // Get draft to check access (NOFO context is resolved server-side inside
    // runCouncilDeliberation).
    const draft = getDraft(id, session.email);
    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const runId = await runCouncilDeliberation(
      id,
      trigger_type,
      session.email
    );

    return NextResponse.json({
      council_run_id: runId,
      status: "started"
    });

  } catch (error) {
    console.error("Start draft council error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start council run" },
      { status: 500 }
    );
  }
}