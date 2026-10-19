// POST /api/contacts/[id]/interaction
// Record a contact outreach interaction. Updates contact_count, last_contact_at,
// and rolling response_rate.
// Body: { responded?: boolean }

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { recordContactInteraction } from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type InteractionBody = {
  responded?: boolean;
};

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body: InteractionBody = await req.json().catch(() => ({}));
  const responded = Boolean(body.responded ?? false);

  const contact = recordContactInteraction(id, session.email, responded);
  if (!contact) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({ contact });
}
