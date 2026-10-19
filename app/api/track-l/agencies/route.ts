// Track L §7 — GET /api/track-l/agencies with §6 filters as query params.
import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listAgencies, type ListAgenciesFilters } from "@/lib/track-l";
import { isTier, isFundingProgram, type Tier, type FundingProgram } from "@/lib/track-l-types";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const num = (k: string) => {
    const v = sp.get(k);
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const tierParam = sp.get("tier");
  const programParam = sp.get("program");
  const sortParam = sp.get("sort");

  const filters: ListAgenciesFilters = {
    state: sp.get("state") ?? undefined,
    tier: tierParam && isTier(tierParam) ? (tierParam as Tier) : undefined,
    program:
      programParam && isFundingProgram(programParam) ? (programParam as FundingProgram) : undefined,
    scoreMin: num("scoreMin"),
    scoreMax: num("scoreMax"),
    q: sp.get("q") ?? undefined,
    sort:
      sortParam === "name" || sortParam === "state" || sortParam === "contacts" || sortParam === "score"
        ? sortParam
        : undefined,
    limit: num("limit"),
    offset: num("offset"),
  };
  const { rows, total } = listAgencies(filters);
  return Response.json({ agencies: rows, total });
}
