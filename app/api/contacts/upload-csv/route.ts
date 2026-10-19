// P5 — POST /api/contacts/upload-csv: upload a lead CSV (any export with a
// header row) → contacts. Dedupes against existing contacts by email (or
// name+agency when no email). Creates records only — NOTHING is sent.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { createContact, listContacts } from "@/lib/db";
import { parseContactsCsv } from "@/lib/contacts-csv";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_CSV_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  let text: string;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "file_required" }, { status: 400 });
    if (file.size > MAX_CSV_BYTES) return Response.json({ error: "file_too_large_5mb" }, { status: 413 });
    text = await file.text();
  } else {
    text = await req.text();
    if (text.length > MAX_CSV_BYTES) return Response.json({ error: "file_too_large_5mb" }, { status: 413 });
  }

  const { leads, skippedRows } = parseContactsCsv(text);
  if (leads.length === 0) {
    return Response.json({ error: "no_parseable_rows — need a header row with at least a Name (or First/Last Name) column" }, { status: 400 });
  }

  // Dedupe against existing contacts.
  const existing = listContacts(session.email, { limit: 10_000 });
  const seenEmails = new Set(existing.map((c) => c.email?.toLowerCase()).filter(Boolean) as string[]);
  const seenNameAgency = new Set(existing.map((c) => `${c.name.toLowerCase()}|${(c.agency ?? "").toLowerCase()}`));

  let imported = 0;
  let skippedDupes = 0;
  for (const lead of leads) {
    const emailKey = lead.email?.toLowerCase();
    const naKey = `${lead.name.toLowerCase()}|${(lead.agency ?? "").toLowerCase()}`;
    if ((emailKey && seenEmails.has(emailKey)) || seenNameAgency.has(naKey)) {
      skippedDupes++;
      continue;
    }
    createContact({
      userEmail: session.email,
      name: lead.name,
      title: lead.title,
      agency: lead.agency,
      email: lead.email,
      phone: lead.phone,
      linkedinUrl: lead.linkedinUrl,
      notes: lead.notes,
      tags: ["csv-import"],
      source: "csv_upload",
    });
    if (emailKey) seenEmails.add(emailKey);
    seenNameAgency.add(naKey);
    imported++;
  }

  tryLogActivity({
    actor: session.email,
    actionType: "scout_ingested",
    targetType: "contacts",
    targetId: "csv_upload",
    summary: `CSV lead upload: ${imported} imported, ${skippedDupes} duplicates, ${skippedRows} unparseable rows`,
  });

  return Response.json({ ok: true, imported, skippedDupes, skippedRows, totalParsed: leads.length });
}
