import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft } from "@/lib/db";
import { createSnapshot, listSnapshots } from "@/lib/snapshots";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
  const snapshots = listSnapshots(id, session.email).map((s) => ({
    id: s.id,
    snapshotNo: s.snapshotNo,
    createdAt: s.createdAt,
    note: s.note,
  }));
  return Response.json({ snapshots });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { note?: string };
  try {
    const snap = createSnapshot({
      draftId: id,
      userEmail: session.email,
      note: body.note ?? null,
    });
    return Response.json({
      snapshot: {
        id: snap.id,
        snapshotNo: snap.snapshotNo,
        createdAt: snap.createdAt,
        note: snap.note,
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "snapshot_failed" },
      { status: 400 },
    );
  }
}
