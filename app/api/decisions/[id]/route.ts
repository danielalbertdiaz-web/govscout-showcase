import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDecision, resolveDecision } from "@/lib/decisions";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const d = getDecision(id);
  if (!d || d.userEmail !== session.email) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ decision: d });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    status?: "decided" | "deferred" | "dismissed";
    decision?: string;
    decisionNote?: string;
  };
  if (!body.status || !["decided", "deferred", "dismissed"].includes(body.status)) {
    return Response.json({ error: "invalid status" }, { status: 400 });
  }
  const updated = resolveDecision({
    id,
    userEmail: session.email,
    status: body.status,
    decision: body.decision,
    decisionNote: body.decisionNote,
  });
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ decision: updated });
}
