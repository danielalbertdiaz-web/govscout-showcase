import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { composeGrantOutreach } from "@/lib/grant-outreach";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// S1: compose the "let's pursue this grant together" DRAFT for a recommended
// org. Returns subject + markdown for copy/paste or a mailto link — the
// standing rule holds: NOTHING auto-sends.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const orgName = String(body.orgName ?? "").trim();
  const grantTitle = String(body.grantTitle ?? "").trim();
  if (!orgName || !grantTitle) {
    return Response.json({ error: "orgName and grantTitle are required" }, { status: 400 });
  }
  const draft = composeGrantOutreach({
    orgName,
    grantTitle,
    agency: body.agency ? String(body.agency) : null,
    deadline: body.deadline ? String(body.deadline) : null,
    url: body.url ? String(body.url) : null,
    focusAreas: Array.isArray(body.focusAreas) ? body.focusAreas.map(String) : [],
    knownPartner: body.knownPartner === true,
    senderName: session.name ?? undefined,
  });
  logActivity({
    actor: session.email,
    actionType: "grant_outreach_drafted",
    targetType: "search",
    targetId: null,
    summary: `Drafted teaming outreach to ${orgName} for "${grantTitle.slice(0, 80)}" (draft only — not sent).`,
  });
  return Response.json({ draft });
}
