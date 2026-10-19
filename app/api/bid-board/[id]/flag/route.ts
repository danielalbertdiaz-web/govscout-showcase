// Priority flag for a Bid Board (fp_opportunities) row — migration 041.
//
// POST { flagged: boolean }. Deliberately NOT part of the PATCH edit
// whitelist on ../route.ts: flagged_at may only be written through setFpFlag,
// which logs the flagged/unflagged event with who made the call (the session
// email) and when. A priority call is a judgement, not a field edit.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { setFpFlag } from "@/lib/federal-pipeline";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as { flagged?: unknown } | null;
  if (!body || typeof body.flagged !== "boolean") {
    return Response.json({ error: "flagged_must_be_boolean" }, { status: 400 });
  }

  try {
    const { opp, changed } = setFpFlag(id, body.flagged, { by: session.email });
    return Response.json({ opportunity: opp, changed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("no opportunity matches")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ error: message }, { status: 400 });
  }
}
