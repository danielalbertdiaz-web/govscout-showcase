import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  ACTION_KINDS,
  createDecision,
  isDecisionStatus,
  listDecisions,
  type ActionKind,
  type DecisionStatus,
} from "@/lib/decisions";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const items = listDecisions({
    userEmail: session.email,
    status: status && isDecisionStatus(status) ? (status as DecisionStatus) : undefined,
  });
  return Response.json({ decisions: items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!body.question || typeof body.question !== "string") {
    return Response.json({ error: "question required" }, { status: 400 });
  }
  if (!Array.isArray(body.options) || body.options.length === 0) {
    return Response.json({ error: "options required" }, { status: 400 });
  }
  const actionKind =
    typeof body.actionKind === "string" && (ACTION_KINDS as readonly string[]).includes(body.actionKind)
      ? (body.actionKind as ActionKind)
      : null;
  const created = createDecision({
    userEmail: session.email,
    question: body.question,
    contextType: (body.contextType as string | null) ?? null,
    contextId: (body.contextId as string | null) ?? null,
    options: body.options.map(String),
    recommendedOption: (body.recommendedOption as string | null) ?? null,
    recommendedReason: (body.recommendedReason as string | null) ?? null,
    deadlineMs: typeof body.deadlineMs === "number" ? body.deadlineMs : null,
    actionKind,
    actionPayload: (body.actionPayload as Record<string, unknown> | null) ?? null,
  });
  return Response.json({ decision: created });
}
