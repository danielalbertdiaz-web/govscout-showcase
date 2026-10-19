import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listPartners } from "@/lib/partners";
import { loadReferenceData } from "@/lib/reference-data";
import { recommendPartners } from "@/lib/partner-match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// S1: who should Acme team with to WIN the grants this search surfaced?
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { q?: string; titles?: string[] };
  const q = String(body.q ?? "").trim();
  const titles = Array.isArray(body.titles) ? body.titles.map(String).slice(0, 15) : [];
  if (!q && titles.length === 0) return Response.json({ recommendations: [] });

  const [partners, reference] = await Promise.all([
    listPartners(),
    loadReferenceData().catch(() => ({ orgs: [], metadata: {} })),
  ]);
  const recommendations = recommendPartners({
    query: q,
    resultTitles: titles,
    partners: partners.map((p) => ({
      id: p.id,
      name: p.name,
      capabilities: p.capabilities ?? [],
    })),
    referenceOrgs: reference.orgs,
  });
  return Response.json({ recommendations });
}
