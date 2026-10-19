import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { restoreSnapshot } from "@/lib/snapshots";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; snapId: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id, snapId } = await ctx.params;
  try {
    const restored = restoreSnapshot({ snapshotId: snapId, userEmail: session.email });
    if (restored.id !== id) {
      return Response.json({ error: "draft_mismatch" }, { status: 400 });
    }
    return Response.json({ ok: true, draft: { id: restored.id, title: restored.title } });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "restore_failed" },
      { status: 400 },
    );
  }
}
