import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { createPool, getPool } from "@/lib/db";
import { getItem, updateItem } from "@/lib/scouts";

export const runtime = "nodejs";

type PromoteBody = {
  // If poolId is provided, link the item to that existing pool.
  // If not, create a new pool seeded from the item's fields.
  poolId?: string;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const item = getItem(id, session.email);
  if (!item) return Response.json({ error: "not_found" }, { status: 404 });

  const body: PromoteBody = await req.json().catch(() => ({}) as PromoteBody);

  let poolId: string;
  if (body.poolId) {
    const existing = getPool(body.poolId, session.email);
    if (!existing) return Response.json({ error: "pool_not_found" }, { status: 404 });
    poolId = existing.id;
  } else {
    const pool = createPool({
      userEmail: session.email,
      name: item.title.slice(0, 240),
      source: item.url ?? null,
      agency: item.agency,
      jurisdiction: null,
      status: "discovered",
      playType: null,
      allocatedAmount: null,
      unspentAmount: null,
      deadlineDate: null,
      deadlineLabel: item.deadlineText,
      fitSummary: item.rawText.slice(0, 2000),
      wedge: null,
      nextAction: null,
      notes: `Promoted from Gov Scout digest item on ${new Date().toISOString()}.`,
      tags: [item.source],
    });
    poolId = pool.id;
  }

  const updated = updateItem(id, session.email, { status: "promoted", poolId });
  return Response.json({ item: updated, poolId });
}
