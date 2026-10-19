// Item 5.2 — subaward / teaming notices scan endpoint.
//
//   GET  /api/cron/teaming-scan   (the WEEKLY CRON target — distinct cadence
//        from the RFP + foundation crons)
//        Auth: `Authorization: Bearer $CRON_SECRET` (Vercel cron convention) OR
//        a logged-in session. Owner resolved from the session, else
//        TEAMING_SCAN_OWNER, else FOUNDATION_SCAN_OWNER, else the first user.
//   POST /api/cron/teaming-scan   (manual "scan now" — session required)
//
// Discovers SAM.gov Special-Notice / Sources-Sought subaward notices in Acme/Tech
// Savers' target NAICS, scores teaming-fit, and persists them for the /teaming
// view. NOTHING is sent — this only persists candidate notices for triage. The
// SAM.gov source is a dark seam: without SAM_GOV_API_KEY the scan is a no-op.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadUsers } from "@/lib/auth-users";
import { runTeamingScan } from "@/lib/teaming-scan";

export const runtime = "nodejs";
export const maxDuration = 60;

function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

function resolveOwnerEmail(sessionEmail: string | null): string | null {
  if (sessionEmail) return sessionEmail;
  const configured =
    process.env.TEAMING_SCAN_OWNER?.trim() || process.env.FOUNDATION_SCAN_OWNER?.trim();
  if (configured) return configured;
  const users = loadUsers();
  return users[0]?.email ?? null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!cronAuthorized(req) && !session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const owner = resolveOwnerEmail(session?.email ?? null);
  if (!owner) return Response.json({ error: "no_owner" }, { status: 400 });

  const result = await runTeamingScan(owner);
  return Response.json({ ok: true, sent: false, owner, ...result });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await runTeamingScan(session.email);
  return Response.json({ ok: true, sent: false, owner: session.email, ...result });
}
