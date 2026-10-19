import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { deleteNofo, getNofo, updateNofo, type UpdateNofoInput } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const nofo = getNofo(id, session.email);
  if (!nofo) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ nofo });
}

type UpdateBody = {
  agency?: string | null;
  program?: string | null;
  fundingFloor?: string | null;
  fundingCeiling?: string | null;
  periodOfPerformance?: string | null;
  eligibility?: string | null;
  evaluationCriteria?: string | null;
  requiredSections?: string[];
  summary?: string | null;
  tags?: string[];
};

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const body: UpdateBody = await req.json().catch(() => ({}));
  const patch: UpdateNofoInput = {};
  if ("agency" in body) patch.agency = body.agency ?? null;
  if ("program" in body) patch.program = body.program ?? null;
  if ("fundingFloor" in body) patch.fundingFloor = body.fundingFloor ?? null;
  if ("fundingCeiling" in body) patch.fundingCeiling = body.fundingCeiling ?? null;
  if ("periodOfPerformance" in body) patch.periodOfPerformance = body.periodOfPerformance ?? null;
  if ("eligibility" in body) patch.eligibility = body.eligibility ?? null;
  if ("evaluationCriteria" in body) patch.evaluationCriteria = body.evaluationCriteria ?? null;
  if ("summary" in body) patch.summary = body.summary ?? null;
  if (Array.isArray(body.requiredSections)) {
    patch.requiredSections = body.requiredSections.map(String).filter(Boolean);
  }
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags.map((t) => String(t).trim()).filter(Boolean);
  }

  const updated = updateNofo(id, session.email, patch);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ nofo: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = deleteNofo(id, session.email);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
