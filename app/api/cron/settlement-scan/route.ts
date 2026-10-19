// Item 5.3 — opioid-settlement board discovery scan.
//
//   GET  /api/cron/settlement-scan   (the periodic CRON target)
//        Auth: `Authorization: Bearer $CRON_SECRET` (Vercel cron convention) OR
//        a logged-in session. Owner resolved from the session, else
//        SETTLEMENT_SCAN_OWNER, else FOUNDATION_SCAN_OWNER, else first user.
//   POST /api/cron/settlement-scan   (manual "scan now" — session required)
//
// Crawls the curated state/county settlement-board catalogue (Apify watcher,
// family "settlement") and ingests new listings as scout_items tagged
// funding_source:opioid_settlement. NOTHING is sent — discovery + persist only.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadUsers } from "@/lib/auth-users";
import { runSettlementScan } from "@/lib/settlement-scan";

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
    process.env.SETTLEMENT_SCAN_OWNER?.trim() || process.env.FOUNDATION_SCAN_OWNER?.trim();
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

  const result = await runSettlementScan(owner);
  return Response.json({ ...result, sent: false, owner });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await runSettlementScan(session.email);
  return Response.json({ ...result, sent: false, owner: session.email });
}
