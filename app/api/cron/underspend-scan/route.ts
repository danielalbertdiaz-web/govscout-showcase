// Item U1 — underspend / unallocated-funding discovery scan.
//
//   GET  /api/cron/underspend-scan   (the periodic CRON target)
//        Auth: `Authorization: Bearer $CRON_SECRET` OR a logged-in session.
//   POST /api/cron/underspend-scan   (manual "scan now" — session required)
//
// Pulls unspent/unobligated federal-account balances (USASpending.gov, free),
// RANKS them by the underspend model, and upserts the top pools into the
// existing funding_pools table (visible at /pools). NOTHING is sent.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadUsers } from "@/lib/auth-users";
import { runUnderspendScan } from "@/lib/underspend-scan";

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
    process.env.UNDERSPEND_SCAN_OWNER?.trim() || process.env.FOUNDATION_SCAN_OWNER?.trim();
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

  const result = await runUnderspendScan(owner);
  return Response.json({ ok: true, sent: false, owner, ...result });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await runUnderspendScan(session.email);
  return Response.json({ ok: true, sent: false, owner: session.email, ...result });
}
