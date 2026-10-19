import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDigest, listItemsForDigest } from "@/lib/scouts";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const digest = getDigest(id, session.email);
  if (!digest) return Response.json({ error: "not_found" }, { status: 404 });
  const items = listItemsForDigest(id, session.email);
  return Response.json({ digest, items });
}
