import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { composePoolHolderOutreach, composePoolPartnerOutreach } from "@/lib/pool-activation";
import { recommendPartners } from "@/lib/partner-match";
import { listPartners } from "@/lib/partners";
import { loadReferenceData } from "@/lib/reference-data";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// R2: activation bundle for a pool — the holder outreach draft plus ranked
// partner/non-profit candidates who could receive the funds or move the
// holder locally.
export async function GET(_req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const pool = getPool(id, session.email);
  if (!pool) return Response.json({ error: "not_found" }, { status: 404 });

  const holderDraft = composePoolHolderOutreach(pool, { senderName: session.name ?? undefined });

  const [partners, reference] = await Promise.all([
    listPartners(),
    loadReferenceData().catch(() => ({ orgs: [], metadata: {} })),
  ]);
  const recommendations = recommendPartners({
    query: [pool.name, pool.fitSummary ?? "", pool.tags.join(" ")].join(" "),
    resultTitles: [],
    partners: partners.map((p) => ({ id: p.id, name: p.name, capabilities: p.capabilities ?? [] })),
    referenceOrgs: reference.orgs,
  });

  return Response.json({ holderDraft, recommendations });
}

// R2: compose the partner-play outreach for one recommended org.
export async function POST(req: NextRequest, ctx: Ctx) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const pool = getPool(id, session.email);
  if (!pool) return Response.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const orgName = String(body.orgName ?? "").trim();
  if (!orgName) return Response.json({ error: "orgName required" }, { status: 400 });

  const draft = composePoolPartnerOutreach(
    pool,
    { name: orgName, focusAreas: Array.isArray(body.focusAreas) ? body.focusAreas.map(String) : [] },
    { senderName: session.name ?? undefined, knownPartner: body.knownPartner === true },
  );
  logActivity({
    actor: session.email,
    actionType: "pool_outreach_drafted",
    targetType: "pool",
    targetId: pool.id,
    summary: `Drafted pool-activation outreach to ${orgName} for "${pool.name.slice(0, 80)}" (draft only — not sent).`,
  });
  return Response.json({ draft });
}
