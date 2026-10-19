import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft } from "@/lib/db";
import {
  addWorkingDraftItem,
  assembleAndStore,
  latestAssembly,
  listWorkingDraftItems,
  reorderWorkingDraftItems,
} from "@/lib/working-draft";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    items: listWorkingDraftItems(id),
    assembly: latestAssembly(id),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "add";

  if (action === "reorder") {
    const ids = Array.isArray(body.orderedIds)
      ? body.orderedIds.filter((x): x is string => typeof x === "string")
      : [];
    return Response.json({ items: reorderWorkingDraftItems(id, ids) });
  }

  if (action === "assemble") {
    const docTitle = typeof body.documentTitle === "string" ? body.documentTitle : draft.title;
    const assembly = assembleAndStore(id, docTitle);
    return Response.json({ assembly });
  }

  // default: add a promoted block
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const bodyMarkdown = typeof body.bodyMarkdown === "string" ? body.bodyMarkdown : "";
  if (!title && !bodyMarkdown.trim()) {
    return Response.json({ error: "title or bodyMarkdown required" }, { status: 400 });
  }
  const item = addWorkingDraftItem({
    draftId: id,
    title: title || "Untitled block",
    bodyMarkdown,
    sourceKind: typeof body.sourceKind === "string" ? body.sourceKind : "section",
    sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : null,
  });
  return Response.json({ item });
}
