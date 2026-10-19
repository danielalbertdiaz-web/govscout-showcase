import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deleteSuggestion,
  getSuggestion,
  isSuggestionStatus,
  updateSuggestionStatus,
  type SuggestionStatus,
} from "@/lib/suggestions";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    status?: string;
    resolutionNote?: string;
  };
  if (!body.status || !isSuggestionStatus(body.status)) {
    return Response.json({ error: "invalid status" }, { status: 400 });
  }
  const updated = updateSuggestionStatus(
    id,
    session.email,
    body.status as SuggestionStatus,
    body.resolutionNote,
  );
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ suggestion: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const existing = getSuggestion(id, session.email);
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
  const ok = deleteSuggestion(id, session.email);
  return Response.json({ ok });
}
