// GET    /api/contacts/[id]/opportunities — list opportunities linked to a contact
// POST   /api/contacts/[id]/opportunities — link a contact to an opportunity
// DELETE /api/contacts/[id]/opportunities — unlink a contact from an opportunity
// Body for POST/DELETE: { opportunityId: string }

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getContact,
  getSavedOpportunity,
  linkContactOpportunity,
  unlinkContactOpportunity,
} from "@/lib/db";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const contact = getContact(id, session.email);
  if (!contact) return Response.json({ error: "not_found" }, { status: 404 });
  // Return contacts that share linked opportunities — reverse-lookup not yet
  // stored per-contact, so we return a placeholder for now.
  return Response.json({ contactId: id, message: "Use GET /api/opportunities/[id]/contacts to list contacts per opportunity." });
}

type LinkBody = { opportunityId?: string };

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const contact = getContact(id, session.email);
  if (!contact) return Response.json({ error: "contact_not_found" }, { status: 404 });

  const body: LinkBody = await req.json().catch(() => ({}));
  const oppId = String(body.opportunityId ?? "").trim();
  if (!oppId) return Response.json({ error: "opportunityId_required" }, { status: 400 });

  const opp = getSavedOpportunity(oppId, session.email);
  if (!opp) return Response.json({ error: "opportunity_not_found" }, { status: 404 });

  linkContactOpportunity(id, oppId);
  return Response.json({ ok: true, contactId: id, opportunityId: oppId });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const contact = getContact(id, session.email);
  if (!contact) return Response.json({ error: "contact_not_found" }, { status: 404 });

  const body: LinkBody = await req.json().catch(() => ({}));
  const oppId = String(body.opportunityId ?? "").trim();
  if (!oppId) return Response.json({ error: "opportunityId_required" }, { status: 400 });

  unlinkContactOpportunity(id, oppId);
  return Response.json({ ok: true });
}
