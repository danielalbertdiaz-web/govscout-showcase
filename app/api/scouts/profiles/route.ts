import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createCustomScout,
  deleteCustomScout,
  listCustomScouts,
  setCustomScoutEnabled,
} from "@/lib/custom-scouts";
import { SCOUT_PROFILES } from "@/lib/scout-profiles";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ builtin: SCOUT_PROFILES, custom: listCustomScouts() });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    const scout = createCustomScout({
      label: String(body.label ?? ""),
      keywords: Array.isArray(body.keywords) ? body.keywords.map(String) : [],
      naics: Array.isArray(body.naics) ? body.naics.map(String) : [],
      champion: body.champion ? String(body.champion) : undefined,
    });
    logActivity({
      actor: session.email,
      actionType: "scout_profile_created",
      targetType: "scout_profile",
      targetId: scout.id,
      summary: `Created scout "${scout.label}" (${scout.keywords.length} keywords).`,
    });
    return Response.json({ ok: true, scout });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not create scout." },
      { status: 400 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json();
  const id = String(body.id ?? "");
  if (!id.startsWith("custom_")) {
    return Response.json({ error: "Only custom scouts can be toggled here." }, { status: 400 });
  }
  const ok = setCustomScoutEnabled(id, Boolean(body.enabled));
  return ok
    ? Response.json({ ok: true })
    : Response.json({ error: "Scout not found." }, { status: 404 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id.startsWith("custom_")) {
    return Response.json({ error: "Only custom scouts can be deleted." }, { status: 400 });
  }
  const ok = deleteCustomScout(id);
  if (ok) {
    logActivity({
      actor: session.email,
      actionType: "scout_profile_deleted",
      targetType: "scout_profile",
      targetId: id,
      summary: `Deleted custom scout ${id}.`,
    });
  }
  return ok
    ? Response.json({ ok: true })
    : Response.json({ error: "Scout not found." }, { status: 404 });
}
