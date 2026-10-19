// Micro Contracts cron — daily morning scan for biddable federal contracts.
//
//   GET  /api/cron/micro-contracts-scan  (cron target — 6 AM ET via vercel.json)
//   POST /api/cron/micro-contracts-scan  (manual "scan now" — session required)

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadUsers } from "@/lib/auth-users";
import { runMicroContractScan } from "@/lib/micro-contracts-scan";
import { listMicroContracts } from "@/lib/db";

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
    process.env.MICRO_CONTRACTS_SCAN_OWNER?.trim() ||
    process.env.FOUNDATION_SCAN_OWNER?.trim();
  if (configured) return configured;
  const users = loadUsers();
  return users[0]?.email ?? null;
}

function findUrgent(userEmail: string): { title: string; deadline: string }[] {
  const contracts = listMicroContracts(userEmail);
  const now = Date.now();
  const urgent: { title: string; deadline: string }[] = [];
  for (const c of contracts) {
    if (!c.responseDeadline || c.disposition === "passed" || c.disposition === "submitted" || c.disposition === "won") continue;
    const dl = new Date(c.responseDeadline).getTime();
    if (isNaN(dl)) continue;
    const hoursLeft = (dl - now) / (1000 * 60 * 60);
    if (hoursLeft > 0 && hoursLeft < 48) {
      urgent.push({ title: c.title, deadline: c.responseDeadline });
    }
  }
  return urgent;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!cronAuthorized(req) && !session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const owner = resolveOwnerEmail(session?.email ?? null);
  if (!owner) return Response.json({ error: "no_owner" }, { status: 400 });

  const result = await runMicroContractScan(owner);
  const urgent = findUrgent(owner);

  return Response.json({ ok: true, owner, ...result, urgent });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await runMicroContractScan(session.email);
  const urgent = findUrgent(session.email);

  return Response.json({ ok: true, owner: session.email, ...result, urgent });
}
