// Item 4.5 — per-candidate actions on a scanned non-profit.
//
//   PUT  .../scan-nonprofits/[candidateId]   body: { disposition }
//        → set triage disposition (new | already_contacted | not_interested | partnered)
//   POST .../scan-nonprofits/[candidateId]   (promote)
//        → creates a 4.3 contact LEAD (source:"scanner") from this candidate,
//          links it back, and flips the candidate to already_contacted.
//
// NOTHING is sent — promotion only creates a reviewable contact/lead record.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getNonprofitCandidate,
  setNonprofitCandidateDisposition,
  setNonprofitCandidatePromotedContact,
  createContact,
} from "@/lib/db";
import { isNonprofitDisposition } from "@/lib/nonprofit-scanner";
import { THEME_LABELS, isGrantTheme } from "@/lib/ntee-themes";

export const runtime = "nodejs";

type PutBody = { disposition?: string };

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; candidateId: string }> },
) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { candidateId } = await ctx.params;
  const body: PutBody = await req.json().catch(() => ({}));
  if (!isNonprofitDisposition(body.disposition)) {
    return Response.json({ error: "invalid_disposition" }, { status: 400 });
  }

  const updated = setNonprofitCandidateDisposition(candidateId, session.email, body.disposition);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ candidate: updated });
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; candidateId: string }> },
) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { candidateId } = await ctx.params;
  const cand = getNonprofitCandidate(candidateId, session.email);
  if (!cand) return Response.json({ error: "not_found" }, { status: 404 });
  if (cand.promotedContactId) {
    return Response.json({ error: "already_promoted", contactId: cand.promotedContactId }, { status: 409 });
  }

  const themeLabels = cand.themes
    .filter(isGrantTheme)
    .map((t) => THEME_LABELS[t]);
  const noteLines = [
    "Promoted from non-profit scanner (4.5).",
    cand.ein ? `EIN: ${cand.ein}` : null,
    cand.sourceUrl ? `Source: ${cand.sourceUrl}` : null,
    cand.reasons.length ? `Why: ${cand.reasons.join(" ")}` : null,
  ].filter(Boolean);

  const contact = createContact({
    userEmail: session.email,
    name: cand.name,
    agency: cand.name, // org-level lead — no named person yet
    relationshipQuality: "cold",
    tags: ["nonprofit", "scanner", ...themeLabels],
    notes: noteLines.join("\n"),
    source: "scanner",
    raw: {
      nonprofitCandidateId: cand.id,
      ein: cand.ein,
      nteeCode: cand.nteeCode,
      state: cand.state,
      relevanceScore: cand.relevanceScore,
      sourceUrl: cand.sourceUrl,
    },
  });

  const updated = setNonprofitCandidatePromotedContact(candidateId, session.email, contact.id);
  return Response.json({
    promoted: true,
    sent: false, // explicit: nothing is sent
    contactId: contact.id,
    candidate: updated,
  });
}
