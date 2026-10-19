import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listDigests } from "@/lib/scouts";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const cronJobId = sp.get("cron_job_id") || undefined;
  const limit = sp.get("limit") ? Math.max(1, Math.min(500, Number(sp.get("limit")))) : undefined;
  const digests = listDigests(session.email, { cronJobId, limit });
  return Response.json({ digests });
}
