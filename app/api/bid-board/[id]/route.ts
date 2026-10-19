// Bid Board API — serves fp_opportunities ONLY.
//
// Two namespaces exist on purpose: /api/bid-board/* operates on
// fp_opportunities (the federal pipeline Bid Board), while /api/opportunities/*
// operates on saved_opportunities (the search-results save feature) — a
// different table and a different id space. They briefly shared
// /api/opportunities/[id] (2026-07-31), which put a GET and a PATCH on the
// same URL that addressed different records; do not merge them again.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deleteFpOpportunity,
  isFpStatus,
  isFpTier,
  setFpStatus,
  updateFpOpportunity,
  type FpOpportunityEdit,
} from "@/lib/federal-pipeline";

export const runtime = "nodejs";

// PATCH edits a Bid Board (fp_opportunities) row. Only the whitelisted fields
// below can be written; identity/provenance (id, sol_number, notice_id,
// created_at) are not editable by design. Body keys outside the whitelist are
// ignored, and updateFpOpportunity enforces the same whitelist at runtime.
const FP_EDITABLE = [
  "title",
  "agency",
  "office",
  "naics",
  "setAside",
  "noticeType",
  "tier",
  "url",
  "responseDeadline",
  "priceQuoted",
  "priceBasis",
  "nobidReason",
] as const;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  // Status is NOT an edit field — it is a pipeline transition, and it goes
  // through setFpStatus so the matching trail event lands in the same
  // transaction (never through the edit whitelist, which by design cannot
  // touch status). Added for kanban drag-and-drop (2026-08-13); exclusive on
  // purpose so a drop can never half-apply alongside field edits.
  if ("status" in body) {
    const extras = Object.keys(body).filter((k) => k !== "status" && k !== "note");
    if (extras.length > 0) {
      return Response.json({ error: "status_moves_are_exclusive", got: extras }, { status: 400 });
    }
    const status = body.status;
    if (typeof status !== "string" || !isFpStatus(status)) {
      return Response.json({ error: "invalid_status" }, { status: 400 });
    }
    const note =
      typeof body.note === "string" && body.note.trim()
        ? body.note.trim()
        : `moved on Bid Board by ${session.email}`;
    try {
      const { opp, event } = setFpStatus(id, status, note);
      return Response.json({ opportunity: opp, event });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("no opportunity matches")) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ error: message }, { status: 400 });
    }
  }

  const edit: FpOpportunityEdit = {};
  for (const key of FP_EDITABLE) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === "title") {
      if (typeof value !== "string" || !value.trim()) {
        return Response.json({ error: "title_must_be_nonempty_string" }, { status: 400 });
      }
      edit.title = value;
    } else if (key === "tier") {
      if (value !== null && (typeof value !== "string" || !isFpTier(value))) {
        return Response.json({ error: "invalid_tier" }, { status: 400 });
      }
      edit.tier = value as FpOpportunityEdit["tier"];
    } else if (key === "priceQuoted") {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
        return Response.json({ error: "priceQuoted_must_be_number_or_null" }, { status: 400 });
      }
      edit.priceQuoted = value as number | null;
    } else {
      if (value !== null && typeof value !== "string") {
        return Response.json({ error: `${key}_must_be_string_or_null` }, { status: 400 });
      }
      edit[key] = value as string | null;
    }
  }

  try {
    const opportunity = updateFpOpportunity(id, edit);
    return Response.json({ opportunity });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unknown opportunity id")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ error: message }, { status: 400 });
  }
}

// DELETE is PERMANENT (migration 036, the operator's decision — replaces archive).
// Writes a tombstone so importers never recreate the record, removes the
// row's fp_events, removes the row. There is no undo and no restore.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  try {
    const tombstone = deleteFpOpportunity(id, { reason, by: session.email });
    return Response.json({ deleted: true, tombstone });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("unknown opportunity id")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return Response.json({ error: message }, { status: 400 });
  }
}
