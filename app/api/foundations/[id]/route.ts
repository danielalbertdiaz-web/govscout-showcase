import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deleteFoundation,
  getFoundation,
  isFoundationStatus,
  updateFoundationStatus,
  type FoundationStatus,
} from "@/lib/foundations";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { status?: string };
  if (!body.status || !isFoundationStatus(body.status)) {
    return Response.json({ error: "invalid status" }, { status: 400 });
  }
  const updated = updateFoundationStatus(id, session.email, body.status as FoundationStatus);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ foundation: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const existing = getFoundation(id);
  if (!existing || existing.userEmail !== session.email) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const ok = deleteFoundation(id, session.email);
  return Response.json({ ok });
}
