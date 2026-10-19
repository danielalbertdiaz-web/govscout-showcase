// GET /api/reference — Item 4.4
// Query the curated reference dataset (Google.org winners + non-profit list).
// Filters: ?q= &kind=google_org_winner|nonprofit|all &focus_area= &geography=
// Read-only; feeds the non-profit scanner (4.5) and the /reference browser.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadReferenceData } from "@/lib/reference-data";
import {
  filterReferenceOrgs,
  focusAreasOf,
  type ReferenceKind,
} from "@/lib/reference-orgs";

export const runtime = "nodejs";

function asKind(v: string | null): ReferenceKind | "all" | null {
  if (v === "google_org_winner" || v === "nonprofit") return v;
  if (v === "all") return "all";
  return null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const dataset = await loadReferenceData();
  const orgs = filterReferenceOrgs(dataset.orgs, {
    q: sp.get("q"),
    kind: asKind(sp.get("kind")),
    focusArea: sp.get("focus_area"),
    geography: sp.get("geography"),
  });

  return Response.json({
    orgs,
    total: dataset.orgs.length,
    focusAreas: focusAreasOf(dataset.orgs),
    metadata: dataset.metadata,
  });
}
