import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getItem, updateItem } from "@/lib/scouts";
import { isScoutItemStatus, type ScoutItemStatus } from "@/lib/scouts-types";

export const runtime = "nodejs";

type PatchBody = {
  status?: string;
  poolId?: string | null;
  savedOpportunityId?: string | null;
  notes?: string | null;
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const item = getItem(id, session.email);
  if (!item) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ item });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body: PatchBody = await req.json().catch(() => ({}) as PatchBody);

  const status: ScoutItemStatus | undefined =
    body.status && isScoutItemStatus(body.status) ? (body.status as ScoutItemStatus) : undefined;

  const item = updateItem(id, session.email, {
    status,
    poolId: body.poolId === undefined ? undefined : body.poolId,
    savedOpportunityId:
      body.savedOpportunityId === undefined ? undefined : body.savedOpportunityId,
    notes: body.notes === undefined ? undefined : body.notes,
  });
  if (!item) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ item });
}
