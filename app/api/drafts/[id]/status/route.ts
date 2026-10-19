import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getDraftStatus,
  isDraftStatus,
  setDraftStatus,
  type DraftStatus,
} from "@/lib/db";
import { runPreflightById } from "@/lib/preflight";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const status = getDraftStatus(id, session.email);
  if (!status) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(status);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    status?: string;
    override?: string;
    overrideConfirm?: string;
  };
  if (!body.status || !isDraftStatus(body.status)) {
    return Response.json({ error: "invalid status" }, { status: 400 });
  }
  const target = body.status as DraftStatus;

  // Pre-flight gate: only blocks transition INTO `submitted` when there are
  // RED checks AND no valid override.
  if (target === "submitted") {
    const result = runPreflightById(id, session.email);
    if (!result) return Response.json({ error: "not_found" }, { status: 404 });
    if (result.redCount > 0) {
      // Override is "I know what I'm doing" — must include both the reason
      // string and a typed confirmation phrase.
      const REQUIRED_CONFIRM = "I KNOW WHAT I AM DOING";
      const overrideOK =
        typeof body.override === "string" &&
        body.override.trim().length > 5 &&
        body.overrideConfirm?.trim().toUpperCase() === REQUIRED_CONFIRM;
      if (!overrideOK) {
        return Response.json(
          {
            error: "preflight_blocks_submission",
            redCount: result.redCount,
            reds: result.results.filter((r) => r.severity === "red"),
            instruction: `To override, include override: <reason> and overrideConfirm: "${REQUIRED_CONFIRM}".`,
          },
          { status: 422 },
        );
      }
      setDraftStatus({
        draftId: id,
        userEmail: session.email,
        status: target,
        preflightResult: result as unknown as Record<string, unknown>,
        override: `${body.override} (red count: ${result.redCount})`,
      });
      tryLogActivity({
        actor: session.email,
        actionType: "draft_status_changed",
        targetType: "draft",
        targetId: id,
        summary: `Draft submitted (override): ${body.override}`,
      });
      return Response.json({ ok: true, status: target, overridden: true });
    }
    setDraftStatus({
      draftId: id,
      userEmail: session.email,
      status: target,
      preflightResult: result as unknown as Record<string, unknown>,
    });
    tryLogActivity({
      actor: session.email,
      actionType: "draft_status_changed",
      targetType: "draft",
      targetId: id,
      summary: `Draft submitted (pre-flight clean: ${result.greenCount}/${result.yellowCount}/${result.redCount})`,
    });
    return Response.json({ ok: true, status: target });
  }

  // Non-submitted transitions: no pre-flight gate.
  const ok = setDraftStatus({ draftId: id, userEmail: session.email, status: target });
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  tryLogActivity({
    actor: session.email,
    actionType: "draft_status_changed",
    targetType: "draft",
    targetId: id,
    summary: `Draft → ${target}`,
  });
  return Response.json({ ok: true, status: target });
}
