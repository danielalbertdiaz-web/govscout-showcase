import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { deleteDraft, getDraft, listVersions, saveDraft } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  const versions = listVersions(id, session.email);
  return Response.json({ draft, versions });
}

type PatchBody = {
  nofoId?: string | null;
  poolId?: string | null;
};

// Light partial update for linkage-only mutations (NOFO + pool).
// Full draft saves continue to flow through POST /api/drafts.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const existing = getDraft(id, session.email);
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });

  const body: PatchBody = await req.json().catch(() => ({}));
  const draft = saveDraft({
    id: existing.id,
    userEmail: existing.userEmail,
    title: existing.title,
    business: existing.business,
    naics: existing.naics,
    opportunity: existing.opportunity,
    blocks: existing.blocks,
    structured: existing.structured,
    sections: existing.sections,
    meta: existing.meta,
    nofoId: "nofoId" in body ? body.nofoId ?? null : existing.nofoId,
    poolId: "poolId" in body ? body.poolId ?? null : existing.poolId,
  });
  return Response.json({ draft });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = deleteDraft(id, session.email);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
