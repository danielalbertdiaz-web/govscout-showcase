import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { listSavedOpportunities, saveOpportunity, type SaveOpportunityInput } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const items = listSavedOpportunities(session.email);
  return Response.json({ items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Partial<SaveOpportunityInput>;
  if (!body.source || !body.sourceId || !body.title) {
    return Response.json({ error: "missing_fields", required: ["source", "sourceId", "title"] }, { status: 400 });
  }

  const input: SaveOpportunityInput = {
    source: body.source,
    sourceId: String(body.sourceId),
    title: String(body.title),
    agency: body.agency ?? null,
    deadline: body.deadline ?? null,
    fundingFloor: body.fundingFloor ?? null,
    fundingCeiling: body.fundingCeiling ?? null,
    eligibility: body.eligibility ?? null,
    url: body.url ?? null,
    nofoUrl: body.nofoUrl ?? null,
    summary: body.summary ?? null,
    naics: body.naics ?? null,
    raw: body.raw ?? null,
    notes: body.notes ?? null,
  };

  const saved = saveOpportunity(session.email, input);
  return Response.json({ opportunity: saved });
}
