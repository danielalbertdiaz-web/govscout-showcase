import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getBoilerplate, listPinsForDraft, pinBoilerplateToDraft, stalePinsForDraft } from "@/lib/boilerplate";
import { getDraft, saveDraft } from "@/lib/db";
import type { SectionMap } from "@/lib/sections";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    pins: listPinsForDraft(id),
    stale: stalePinsForDraft(id),
  });
}

// POST: insert a boilerplate block into a draft section and pin the version.
export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as {
    blockKey?: string;
    section?: string;
  };
  if (!body.blockKey) return Response.json({ error: "blockKey required" }, { status: 400 });
  if (!body.section) return Response.json({ error: "section required" }, { status: 400 });
  const block = getBoilerplate(body.blockKey);
  if (!block) return Response.json({ error: "unknown_block" }, { status: 404 });
  const sectionKey = body.section as keyof SectionMap;
  const newSections: SectionMap = { ...draft.sections };
  const existing = newSections[sectionKey] ?? "";
  const separator = existing.trim() ? "\n\n" : "";
  newSections[sectionKey] = `${existing}${separator}${block.bodyMarkdown}\n`;
  const saved = saveDraft({
    id: draft.id,
    userEmail: session.email,
    title: draft.title,
    business: draft.business,
    naics: draft.naics,
    opportunity: draft.opportunity,
    blocks: draft.blocks,
    structured: draft.structured,
    sections: newSections,
    meta: draft.meta,
    nofoId: null,
    poolId: null,
  });
  const pin = pinBoilerplateToDraft({
    draftId: draft.id,
    blockKey: block.key,
    positionHint: body.section,
  });
  return Response.json({ draft: saved, pin, block: { key: block.key, version: block.version } });
}
