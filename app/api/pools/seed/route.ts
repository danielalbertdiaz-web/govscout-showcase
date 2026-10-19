import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { seedPoolsForUser } from "@/lib/seed-pools";

export const runtime = "nodejs";

// One-shot bootstrap of the sample pools. Idempotent —
// returns { seeded: 0, existing: N } if the user already has pool records.
// Pass `?force=1` (or `{ force: true }`) to seed anyway (won't dedupe by name).
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const queryForce = url.searchParams.get("force") === "1";
  const body = await req.json().catch(() => ({} as { force?: boolean }));
  const force = queryForce || body?.force === true;

  const result = seedPoolsForUser(session.email, force);
  return Response.json(result);
}
