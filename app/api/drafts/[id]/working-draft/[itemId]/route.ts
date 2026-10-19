import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft } from "@/lib/db";
import { removeWorkingDraftItem, updateWorkingDraftItem } from "@/lib/working-draft";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id, itemId } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    bodyMarkdown?: string;
  };
  const updated = updateWorkingDraftItem(id, itemId, {
    title: typeof body.title === "string" ? body.title : undefined,
    bodyMarkdown: typeof body.bodyMarkdown === "string" ? body.bodyMarkdown : undefined,
  });
  if (!updated) return Response.json({ error: "item_not_found" }, { status: 404 });
  return Response.json({ item: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id, itemId } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  const removed = removeWorkingDraftItem(id, itemId);
  if (!removed) return Response.json({ error: "item_not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
