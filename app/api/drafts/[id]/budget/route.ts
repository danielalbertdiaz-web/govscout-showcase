// Item N2 — persist a draft's budget input (meta.budget) and return the
// computed result. Computation is the pure lib/budget core; the LLM never
// touches the numbers.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getDraft, saveDraft } from "@/lib/db";
import { computeBudget, generateBudgetNarrative, type BudgetInput } from "@/lib/budget";

export const runtime = "nodejs";

function sanitizeInput(raw: unknown): BudgetInput {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const personnel = Array.isArray(r.personnel)
    ? r.personnel
        .map((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          return { role: str(o.role), annualSalary: num(o.annualSalary), ftePct: num(o.ftePct), months: num(o.months) };
        })
        .filter((p) => p.role && p.annualSalary > 0)
    : [];
  const subawards = Array.isArray(r.subawards)
    ? r.subawards
        .map((s) => {
          const o = (s ?? {}) as Record<string, unknown>;
          return { partner: str(o.partner), amount: num(o.amount), scope: str(o.scope) || undefined, fixedPrice: Boolean(o.fixedPrice) };
        })
        .filter((s) => s.partner && s.amount > 0)
    : [];
  const otherDirect = Array.isArray(r.otherDirect)
    ? r.otherDirect
        .map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return { label: str(o.label), amount: num(o.amount) };
        })
        .filter((x) => x.label && x.amount > 0)
    : [];
  const base = r.indirectBase;
  return {
    personnel,
    subawards,
    otherDirect,
    fringeRatePct: r.fringeRatePct == null ? undefined : num(r.fringeRatePct),
    indirectRatePct: r.indirectRatePct == null ? undefined : num(r.indirectRatePct),
    indirectBase: base === "mtdc" || base === "total_direct" || base === "salaries_fringe" ? base : undefined,
    travel: num(r.travel),
    equipment: num(r.equipment),
    supplies: num(r.supplies),
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const draft = getDraft(id, session.email);
  if (!draft) return Response.json({ error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { budget?: unknown };
  const input = sanitizeInput(body.budget);
  const result = computeBudget(input);
  const narrative = generateBudgetNarrative(input, result);

  const meta = { ...(draft.meta ?? {}), budget: input, budgetUpdatedAt: Date.now() } as Record<string, unknown>;
  saveDraft({
    id: draft.id,
    userEmail: session.email,
    title: draft.title,
    business: draft.business,
    naics: draft.naics,
    opportunity: draft.opportunity,
    blocks: draft.blocks,
    structured: draft.structured,
    sections: draft.sections,
    meta,
    nofoId: draft.nofoId,
    poolId: draft.poolId,
  });

  return Response.json({ ok: true, input, result, narrative });
}
