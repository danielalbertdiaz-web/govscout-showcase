// GET  /api/contacts          — list contacts for the authed user
// POST /api/contacts          — create a new contact

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createContact,
  listContacts,
  type CreateContactInput,
  type ListContactsFilters,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const filters: ListContactsFilters = {
    q: sp.get("q") ?? undefined,
    agency: sp.get("agency") ?? undefined,
    complianceFlag: sp.get("compliance_flag") ?? undefined,
    // Item 4.3 — outreach pipeline + lead source filters
    outreachStatus: sp.get("outreach_status") ?? undefined,
    source: sp.get("source") ?? undefined,
    limit: sp.get("limit") ? Math.max(1, Math.min(500, Number(sp.get("limit")))) : undefined,
  };

  const contacts = listContacts(session.email, filters);
  return Response.json({ contacts });
}

type CreateBody = Partial<Omit<CreateContactInput, "userEmail">>;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body: CreateBody = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) return Response.json({ error: "name_required" }, { status: 400 });

  const contact = createContact({
    userEmail: session.email,
    name,
    title: body.title ?? null,
    agency: body.agency ?? null,
    email: body.email ?? null,
    phone: body.phone ?? null,
    linkedinUrl: body.linkedinUrl ?? null,
    relationshipQuality: body.relationshipQuality ?? "unknown",
    preferredMethod: body.preferredMethod ?? null,
    bestTime: body.bestTime ?? null,
    successNotes: body.successNotes ?? null,
    complianceFlag: body.complianceFlag ?? null,
    complianceNote: body.complianceNote ?? null,
    tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [],
    notes: body.notes ?? null,
    raw: body.raw ?? null,
  });

  return Response.json({ contact }, { status: 201 });
}
