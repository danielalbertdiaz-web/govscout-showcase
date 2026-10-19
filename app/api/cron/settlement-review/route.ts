// Item 5.3 — QUARTERLY settlement-board health review.
//
//   GET  /api/cron/settlement-review   (the QUARTERLY CRON target)
//        Auth: `Authorization: Bearer $CRON_SECRET` OR a logged-in session.
//   POST /api/cron/settlement-review   (manual review — session required)
//
// Probes every catalogued board's dashboard URL to answer "are the monitored
// boards still active? any moved/dead?" — files a Suggestion-Inbox entry for any
// board that has gone dark so the catalogue can be kept current. NOTHING sent.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadUsers } from "@/lib/auth-users";
import { reviewSettlementBoards } from "@/lib/settlement-scan";

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

  const result = await reviewSettlementBoards(owner);
  return Response.json({ ok: true, sent: false, owner, ...result });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await reviewSettlementBoards(session.email);
  return Response.json({ ok: true, sent: false, owner: session.email, ...result });
}
