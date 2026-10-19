// GET /api/opportunities/[id]/contacts
// List contacts linked to a saved opportunity.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getSavedOpportunity, listContactsForOpportunity } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) return Response.json({ error: "not_found" }, { status: 404 });

  const contacts = listContactsForOpportunity(id, session.email);
  return Response.json({ contacts });
}
