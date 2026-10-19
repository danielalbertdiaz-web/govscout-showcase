// PUT /api/opportunities/[id]/pipeline
// Advance or set the proposal pipeline stage on a saved opportunity.
// Body: { stage: PipelineStage | null, meta?: object }

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getSavedOpportunity,
  isPipelineStage,
  setOpportunityPipelineStage,
  type PipelineStage,
} from "@/lib/db";

export const runtime = "nodejs";

// Stage definitions for the response (automation level + human checkpoints).
const STAGE_INFO: Record<
  PipelineStage,
  { duration: string; automation_level: string; human_checkpoints: string[] }
> = {
  identification: {
    duration: "1-2 days",
    automation_level: "high",
    human_checkpoints: ["strategic_review"],
  },
  development: {
    duration: "7-14 days",
    automation_level: "medium",
    human_checkpoints: ["narrative_review", "budget_approval"],
  },
  submission: {
    duration: "1-2 days",
    automation_level: "low",
    human_checkpoints: ["final_review", "signature", "submission"],
  },
  award_tracking: {
    duration: "30-90 days",
    automation_level: "high",
    human_checkpoints: ["strategy_adjustment"],
  },
  execution: {
    duration: "project_length",
    automation_level: "medium",
    human_checkpoints: ["milestone_reviews", "compliance_audits"],
  },
};

type PipelineBody = {
  stage?: string | null;
  meta?: Record<string, unknown> | null;
};

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) return Response.json({ error: "not_found" }, { status: 404 });

  const body: PipelineBody = await req.json().catch(() => ({}));

  // Explicit null clears the stage (removes from pipeline).
  if (body.stage === null) {
    const updated = setOpportunityPipelineStage(id, session.email, null, null);
    return Response.json({ opportunity: updated, stage: null, stageInfo: null });
  }

  if (!body.stage || !isPipelineStage(body.stage)) {
    return Response.json(
      {
        error: "invalid_stage",
        valid: Object.keys(STAGE_INFO),
      },
      { status: 400 },
    );
  }

  const stage = body.stage as PipelineStage;
  const stageInfo = STAGE_INFO[stage];
  const meta: Record<string, unknown> = {
    ...stageInfo,
    ...(body.meta ?? {}),
  };

  const updated = setOpportunityPipelineStage(id, session.email, stage, meta);
  if (!updated) return Response.json({ error: "update_failed" }, { status: 500 });

  return Response.json({ opportunity: updated, stage, stageInfo });
}
