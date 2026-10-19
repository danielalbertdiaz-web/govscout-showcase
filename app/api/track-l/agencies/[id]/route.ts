// Track L §7 — GET /api/track-l/agencies/:id (detail drawer payload).
import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getAgencyDetail } from "@/lib/track-l";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const agency = getAgencyDetail(id);
  if (!agency) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ agency });
}
