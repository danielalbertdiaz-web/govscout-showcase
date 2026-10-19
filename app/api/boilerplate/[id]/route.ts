import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  deleteBoilerplate,
  getBoilerplate,
  updateBoilerplate,
  type BoilerplateUpdate,
} from "@/lib/boilerplate";
import {
  APPROVAL_STATUSES,
  CONFIDENTIALITY_LEVELS,
  isApprovalStatus,
  isConfidentiality,
} from "@/lib/proposal-memory";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const block = getBoilerplate(id);
  if (!block) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ block });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const existing = getBoilerplate(id);
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bodyMarkdown =
    typeof body.bodyMarkdown === "string" ? body.bodyMarkdown : existing.bodyMarkdown;
  if (/jane\s*barred/i.test(bodyMarkdown)) {
    return Response.json(
      { error: 'Block content includes "Jane Barred" — refused per standing rule.' },
      { status: 400 },
    );
  }

  const update: BoilerplateUpdate = {
    title: typeof body.title === "string" ? body.title : existing.title,
    bodyMarkdown,
    notes: typeof body.notes === "string" ? body.notes : existing.notes,
    bumpVersion: body.bumpVersion === true,
  };

  // §14.9 reuse controls — each optional; unknown enum values are rejected
  // with 400, never coerced into a write.
  if (body.approvalStatus !== undefined) {
    if (!isApprovalStatus(body.approvalStatus)) {
      return Response.json(
        { error: "invalid_approval_status", valid: APPROVAL_STATUSES },
        { status: 400 },
      );
    }
    update.approvalStatus = body.approvalStatus;
  }
  if (body.confidentiality !== undefined) {
    if (!isConfidentiality(body.confidentiality)) {
      return Response.json(
        { error: "invalid_confidentiality", valid: CONFIDENTIALITY_LEVELS },
        { status: 400 },
      );
    }
    update.confidentiality = body.confidentiality;
  }
  for (const key of ["effectiveFrom", "expiresAt"] as const) {
    if (body[key] === undefined) continue;
    const v = body[key];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
      return Response.json({ error: `${key}_must_be_epoch_ms_or_null` }, { status: 400 });
    }
    update[key] = v as number | null;
  }
  if (body.doNotReuse !== undefined) {
    if (typeof body.doNotReuse !== "boolean") {
      return Response.json({ error: "doNotReuse_must_be_boolean" }, { status: 400 });
    }
    update.doNotReuse = body.doNotReuse;
  }
  if (body.doNotReuseReason !== undefined) {
    if (body.doNotReuseReason !== null && typeof body.doNotReuseReason !== "string") {
      return Response.json({ error: "doNotReuseReason_must_be_string_or_null" }, { status: 400 });
    }
    update.doNotReuseReason = body.doNotReuseReason as string | null;
  }
  if (body.restrictedFunders !== undefined) {
    if (!Array.isArray(body.restrictedFunders) || body.restrictedFunders.some((f) => typeof f !== "string")) {
      return Response.json({ error: "restrictedFunders_must_be_string_array" }, { status: 400 });
    }
    update.restrictedFunders = body.restrictedFunders as string[];
  }
  if (body.supersededBy !== undefined) {
    if (body.supersededBy !== null && typeof body.supersededBy !== "string") {
      return Response.json({ error: "supersededBy_must_be_block_key_or_null" }, { status: 400 });
    }
    if (typeof body.supersededBy === "string" && !getBoilerplate(body.supersededBy)) {
      return Response.json({ error: "supersededBy_matches_no_block" }, { status: 400 });
    }
    update.supersededBy = body.supersededBy as string | null;
  }
  for (const key of ["source", "permittedUse"] as const) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && typeof body[key] !== "string") {
      return Response.json({ error: `${key}_must_be_string_or_null` }, { status: 400 });
    }
    update[key] = body[key] as string | null;
  }

  try {
    const block = updateBoilerplate(existing.id, update, session.email);
    return Response.json({ block });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const block = getBoilerplate(id);
  if (!block) return Response.json({ error: "not_found" }, { status: 404 });
  deleteBoilerplate(block.id);
  logActivity({
    actor: session.email,
    actionType: "boilerplate_deleted",
    targetType: "boilerplate_block",
    targetId: block.id,
    summary: `Deleted boilerplate block "${block.title}" (${block.key}).`,
  });
  return Response.json({ ok: true });
}
