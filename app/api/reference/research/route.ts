// N6 — POST /api/reference/research: cited funder research via Perplexity
// Sonar. Session-gated; the seam reports `available` so the UI can hide the
// pane when no key is configured.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { funderResearchConfigured, researchFunder } from "@/lib/funder-research";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const maxDuration = 60;

// Cost ceiling, same discipline as the council/Apify guards: the operator's
// Perplexity account has billing attached, so cap calls per calendar month
// well inside the Pro plan's included $5 credits (~500-1,000 questions).
// Override with FUNDER_RESEARCH_MONTHLY_CAP.
const DEFAULT_MONTHLY_CAP = 300;

function monthlyCap(): number {
  const raw = Number(process.env.FUNDER_RESEARCH_MONTHLY_CAP ?? DEFAULT_MONTHLY_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MONTHLY_CAP;
}

function callsThisMonth(): number {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM activity_log
       WHERE target_type = 'reference' AND target_id = 'funder_research' AND created_at >= ?`,
    )
    .get(start.getTime()) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const used = callsThisMonth();
  const cap = monthlyCap();
  return Response.json({
    available: funderResearchConfigured() && used < cap,
    usedThisMonth: used,
    monthlyCap: cap,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!funderResearchConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  const used = callsThisMonth();
  const cap = monthlyCap();
  if (used >= cap) {
    return Response.json(
      { error: `monthly research cap reached (${used}/${cap}) — raise FUNDER_RESEARCH_MONTHLY_CAP to continue` },
      { status: 429 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { question?: unknown };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return Response.json({ error: "question_required" }, { status: 400 });

  const result = await researchFunder(question);
  tryLogActivity({
    actor: session.email,
    actionType: "alfred_tool_call",
    targetType: "reference",
    targetId: "funder_research",
    summary: result.ok
      ? `Funder research: "${question.slice(0, 80)}" (${result.citations.length} citations)`
      : `Funder research FAILED: ${result.error}`,
  });
  if (!result.ok) return Response.json({ error: result.error }, { status: 502 });
  return Response.json({ answer: result.answer, citations: result.citations });
}
