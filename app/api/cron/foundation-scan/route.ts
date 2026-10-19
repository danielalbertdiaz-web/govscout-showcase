// Item 5.1 — weekly foundation-grants scan endpoint.
//
//   GET  /api/cron/foundation-scan   (the WEEKLY CRON target)
//        Auth: `Authorization: Bearer $CRON_SECRET` (Vercel cron convention) OR
//        a logged-in session. Owner resolved from the session, else
//        FOUNDATION_SCAN_OWNER, else the first configured user.
//   POST /api/cron/foundation-scan   (manual "scan now" — session required)
//
// Discovers SUD / behavioral-health / recovery foundation grants from the free
// sources and ingests them into the scouts pipeline tagged source="foundation".
// NOTHING is sent — this only persists candidate grants for triage.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadUsers } from "@/lib/auth-users";
import { runFoundationScan } from "@/lib/foundation-scan";

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
  const configured = process.env.FOUNDATION_SCAN_OWNER?.trim();
  if (configured) return configured;
  const users = loadUsers();
  return users[0]?.email ?? null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  // Allow either a valid cron secret OR an authenticated session.
  if (!cronAuthorized(req) && !session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const owner = resolveOwnerEmail(session?.email ?? null);
  if (!owner) return Response.json({ error: "no_owner" }, { status: 400 });

  const result = await runFoundationScan(owner);
  return Response.json({ ok: true, sent: false, owner, ...result });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await runFoundationScan(session.email);
  return Response.json({ ok: true, sent: false, owner: session.email, ...result });
}
