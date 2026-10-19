import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deletePool,
  getPool,
  isPoolStatus,
  listDraftsForPool,
  updatePool,
  type UpdatePoolInput,
} from "@/lib/db";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const pool = getPool(id, session.email);
  if (!pool) return Response.json({ error: "not_found" }, { status: 404 });
  const drafts = listDraftsForPool(id, session.email).map((d) => ({
    id: d.id,
    title: d.title,
    updatedAt: d.updatedAt,
  }));
  return Response.json({ pool, drafts });
}

type UpdateBody = Partial<UpdatePoolInput>;

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const body: UpdateBody = await req.json().catch(() => ({}));
  const patch: UpdatePoolInput = {};
  const setIf = <K extends keyof UpdateBody>(k: K) => {
    if (k in body) (patch as Record<string, unknown>)[k as string] = body[k];
  };
  setIf("rank");
  setIf("name");
  setIf("source");
  setIf("agency");
  setIf("jurisdiction");
  setIf("playType");
  setIf("allocatedAmount");
  setIf("unspentAmount");
  setIf("deadlineDate");
  setIf("deadlineLabel");
  setIf("fitSummary");
  setIf("wedge");
  setIf("nextAction");
  setIf("notes");

  if ("status" in body) {
    if (typeof body.status === "string" && isPoolStatus(body.status)) {
      patch.status = body.status;
    } else {
      return Response.json({ error: "invalid_status" }, { status: 400 });
    }
  }
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags.map((t) => String(t).trim()).filter(Boolean);
  }

  const before = getPool(id, session.email);
  const updated = updatePool(id, session.email, patch);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  if (before && patch.status && before.status !== patch.status) {
    tryLogActivity({
      actor: session.email,
      actionType: "pool_status_changed",
      targetType: "pool",
      targetId: id,
      summary: `${updated.name}: ${before.status} → ${patch.status}`,
      detail: { from: before.status, to: patch.status },
    });
  }
  return Response.json({ pool: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = deletePool(id, session.email);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
