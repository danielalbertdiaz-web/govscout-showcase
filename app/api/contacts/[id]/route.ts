// GET    /api/contacts/[id]   — fetch a single contact
// PUT    /api/contacts/[id]   — update a contact
// DELETE /api/contacts/[id]   — delete a contact

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deleteContact,
  getContact,
  updateContact,
  setContactOutreachStatus,
  type UpdateContactInput,
} from "@/lib/db";
import { isOutreachStatus } from "@/lib/contact-outreach";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const contact = getContact(id, session.email);
  if (!contact) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ contact });
}

type UpdateBody = Partial<UpdateContactInput>;

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const body: UpdateBody = await req.json().catch(() => ({}));
  const patch: UpdateContactInput = {};

  const setIf = <K extends keyof UpdateBody>(k: K) => {
    if (k in body) (patch as Record<string, unknown>)[k as string] = body[k];
  };

  setIf("name");
  setIf("title");
  setIf("agency");
  setIf("email");
  setIf("phone");
  setIf("linkedinUrl");
  setIf("relationshipQuality");
  setIf("preferredMethod");
  setIf("bestTime");
  setIf("successNotes");
  setIf("complianceFlag");
  setIf("complianceNote");
  setIf("notes");
  setIf("raw");

  if (Array.isArray(body.tags)) {
    patch.tags = body.tags.map((t) => String(t).trim()).filter(Boolean);
  }

  // Item 4.3 — outreach pipeline status moves through its own setter (validated,
  // distinct from the generic field patch).
  const rawStatus = (body as { outreachStatus?: unknown }).outreachStatus;
  if (rawStatus !== undefined) {
    if (!isOutreachStatus(rawStatus)) {
      return Response.json({ error: "invalid_outreach_status" }, { status: 400 });
    }
    const moved = setContactOutreachStatus(id, session.email, rawStatus);
    if (!moved) return Response.json({ error: "not_found" }, { status: 404 });
  }

  const updated = updateContact(id, session.email, patch);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ contact: updated });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = deleteContact(id, session.email);
  if (!ok) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
