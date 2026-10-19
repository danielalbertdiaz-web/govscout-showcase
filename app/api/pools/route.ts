import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createPool,
  isPoolStatus,
  listPools,
  type CreatePoolInput,
  type ListPoolsFilters,
  type PoolStatus,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const statusParam = sp.get("status") ?? undefined;
  const status: PoolStatus | "all" | undefined =
    statusParam === "all"
      ? "all"
      : statusParam && isPoolStatus(statusParam)
        ? (statusParam as PoolStatus)
        : undefined;

  const filters: ListPoolsFilters = {
    status,
    q: sp.get("q") ?? undefined,
    limit: sp.get("limit") ? Math.max(1, Math.min(500, Number(sp.get("limit")))) : undefined,
  };
  const pools = listPools(session.email, filters);
  return Response.json({ pools });
}

type CreateBody = Partial<Omit<CreatePoolInput, "userEmail">> & { name?: string };

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body: CreateBody = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  if (!name) return Response.json({ error: "name_required" }, { status: 400 });

  const status: PoolStatus | undefined =
    body.status && isPoolStatus(body.status) ? (body.status as PoolStatus) : undefined;

  const pool = createPool({
    userEmail: session.email,
    name,
    rank: body.rank ?? null,
    source: body.source ?? null,
    agency: body.agency ?? null,
    jurisdiction: body.jurisdiction ?? null,
    status,
    playType: body.playType ?? null,
    allocatedAmount: body.allocatedAmount ?? null,
    unspentAmount: body.unspentAmount ?? null,
    deadlineDate: body.deadlineDate ?? null,
    deadlineLabel: body.deadlineLabel ?? null,
    fitSummary: body.fitSummary ?? null,
    wedge: body.wedge ?? null,
    nextAction: body.nextAction ?? null,
    notes: body.notes ?? null,
    tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [],
  });
  return Response.json({ pool });
}
