// Item 4.1 — per-draft partner roster.
//   GET  → { roster, available }  (curated entries + the full partner pool)
//   PUT  → replace the roster wholesale with a normalized, validated array.
// Selection is persisted in the draft's meta; nothing here sends anything.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft, getDraftRoster, setDraftPartners } from "@/lib/db";
import { listPartners } from "@/lib/partners";
import { normalizeRosterInput } from "@/lib/draft-partners";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });

  const roster = getDraftRoster(id, session.email);
  const available = await listPartners();
  return Response.json({ roster, available });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as { roster?: unknown };
  const roster = normalizeRosterInput(body.roster);

  const updated = setDraftPartners(id, session.email, roster);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({ ok: true, roster: getDraftRoster(id, session.email) });
}
