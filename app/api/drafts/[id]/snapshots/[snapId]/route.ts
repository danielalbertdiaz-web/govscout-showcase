import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft } from "@/lib/db";
import {
  diffSnapshotsBySections,
  getSnapshot,
} from "@/lib/snapshots";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; snapId: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id, snapId } = await ctx.params;
  const snap = getSnapshot(snapId, session.email);
  if (!snap || snap.draftId !== id) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  if (mode === "diff") {
    const draft = getDraft(id, session.email);
    if (!draft) return Response.json({ error: "not_found" }, { status: 404 });
    const diff = diffSnapshotsBySections(snap, { sections: draft.sections });
    return Response.json({ snapshot: snap, diff });
  }
  return Response.json({ snapshot: snap });
}
