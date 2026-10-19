import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createFoundation,
  isFoundationStatus,
  listFoundations,
  seedFoundationsForUser,
  type FoundationStatus,
} from "@/lib/foundations";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const sourceLabel = url.searchParams.get("source") ?? undefined;
  const items = listFoundations({
    userEmail: session.email,
    status: status && isFoundationStatus(status) ? (status as FoundationStatus) : undefined,
    sourceLabel,
  });
  return Response.json({ foundations: items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.action === "seed") {
    const r = seedFoundationsForUser(session.email);
    return Response.json(r);
  }
  if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
    return Response.json({ error: "title required" }, { status: 400 });
  }
  if (!body.sourceLabel || typeof body.sourceLabel !== "string" || !body.sourceLabel.trim()) {
    return Response.json({ error: "sourceLabel required" }, { status: 400 });
  }
  const status =
    typeof body.status === "string" && isFoundationStatus(body.status)
      ? (body.status as FoundationStatus)
      : "open";
  const created = createFoundation({
    userEmail: session.email,
    sourceLabel: String(body.sourceLabel).trim(),
    title: String(body.title).trim(),
    url: body.url ? String(body.url) : null,
    deadlineText: body.deadlineText ? String(body.deadlineText) : null,
    deadlineDate: body.deadlineDate ? String(body.deadlineDate) : null,
    fundingMin: body.fundingMin ? String(body.fundingMin) : null,
    fundingMax: body.fundingMax ? String(body.fundingMax) : null,
    focusArea: body.focusArea ? String(body.focusArea) : null,
    geography: body.geography ? String(body.geography) : null,
    notes: body.notes ? String(body.notes) : null,
    status,
    sourceKind: body.sourceKind ? String(body.sourceKind) : "foundation",
  });
  return Response.json({ foundation: created });
}
