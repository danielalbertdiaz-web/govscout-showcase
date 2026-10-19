// PUT /api/opportunities/[id]/disposition
// Item 3.1 — set or clear the terminal win/loss disposition on a saved
// opportunity. Body: { disposition: Disposition | null, note?: string }.
// A null disposition clears it back to "undecided" (undo).

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getSavedOpportunity,
  setOpportunityDisposition,
  clearOpportunityDisposition,
} from "@/lib/db";
import { isDisposition, TERMINAL_DISPOSITIONS } from "@/lib/disposition";

export const runtime = "nodejs";

type Body = {
  disposition?: string | null;
  note?: string | null;
};

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) return Response.json({ error: "not_found" }, { status: 404 });

  const body: Body = await req.json().catch(() => ({}));

  // Explicit null clears the disposition.
  if (body.disposition === null) {
    const cleared = clearOpportunityDisposition(id, session.email);
    return Response.json({ opportunity: cleared });
  }

  if (!body.disposition || !isDisposition(body.disposition)) {
    return Response.json(
      { error: "invalid_disposition", valid: TERMINAL_DISPOSITIONS },
      { status: 400 },
    );
  }

  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  const updated = setOpportunityDisposition(id, session.email, body.disposition, note);
  if (!updated) return Response.json({ error: "update_failed" }, { status: 500 });

  return Response.json({ opportunity: updated });
}
