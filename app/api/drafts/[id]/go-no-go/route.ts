// M3 — Go/No-Go endpoints for a draft.
//   GET  → availability + current run state (the panel polls this)
//   POST → start a simulation run (one at a time per draft)

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft } from "@/lib/db";
import { goNoGoAvailable, readGoNoGoState, startGoNoGo } from "@/lib/go-no-go";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    available: goNoGoAvailable(),
    state: readGoNoGoState(draft.meta),
  });
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const result = startGoNoGo(id, session.email);
  if ("error" in result) {
    const status = result.error === "draft_not_found" ? 404 : result.error === "not_configured" ? 503 : 400;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json({ ok: true, state: result });
}
