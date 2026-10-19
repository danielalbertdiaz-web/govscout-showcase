// POST /api/micro-contracts/scan — trigger a scan for biddable contracts
// GET  /api/micro-contracts/scan — return cached results from SQLite

import { getSession } from "@/lib/auth";
import { listMicroContracts } from "@/lib/db";
import { runMicroContractScan } from "@/lib/micro-contracts-scan";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const contracts = listMicroContracts(session.email);
  return Response.json({ contracts });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await runMicroContractScan(session.email);
  const contracts = listMicroContracts(session.email);
  return Response.json({ ok: true, ...result, contracts });
}
