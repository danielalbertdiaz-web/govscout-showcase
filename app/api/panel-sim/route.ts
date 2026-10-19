// Panel-Sim API (thin, per spec §5): GET = list runs (+ latest report),
// POST = start a fresh native-backend run. Heavy lifting stays in lib/; the
// long-running LLM loop is fired without await and lands in ps_runs with a
// status the pane polls. Ingest-mode seeding stays CLI-only.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { FUNNELS, isFunnelKey, aggregate, monteCarlo, renderReportMd } from "@/lib/panel-sim";
import { NativePanelBackend } from "@/lib/panel-sim-native";
import {
  createPanelRun,
  getPanelReport,
  listPanelRuns,
  savePanelReport,
  savePanelResults,
  setPanelRunStatus,
} from "@/lib/panel-sim-store";
import { createDecision } from "@/lib/decisions";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const runId = url.searchParams.get("run");
  if (runId) {
    const report = getPanelReport(runId);
    if (!report) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ report });
  }
  const runs = listPanelRuns(session.email, 50);
  const latest = runs.find((r) => r.status === "complete");
  return Response.json({
    runs,
    latestReport: latest ? getPanelReport(latest.id) : null,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
  const panelSpec = typeof body.panelSpec === "string" ? body.panelSpec.trim() : "";
  const funnelKey = typeof body.funnel === "string" ? body.funnel : "coldemail-deck";
  const n = Math.min(Math.max(Number(body.n) || 16, 2), 32);
  const seed = Number(body.seed) || 42;
  const iterations = Math.min(Math.max(Number(body.iterations) || 1000, 100), 20000);
  const rawArtifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
  const artifacts = rawArtifacts
    .map((a) => {
      const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      return { name: String(o.name ?? "artifact"), content: String(o.content ?? "") };
    })
    .filter((a) => a.content.trim().length > 0);

  if (!isFunnelKey(funnelKey)) {
    return Response.json({ error: `unknown funnel; known: ${Object.keys(FUNNELS).join(", ")}` }, { status: 400 });
  }
  if (!panelSpec || artifacts.length === 0) {
    return Response.json({ error: "panelSpec and at least one artifact{name,content} required" }, { status: 400 });
  }

  const run = createPanelRun({
    userEmail: session.email,
    label: label ?? `${artifacts[0].name} × ${n} personas`,
    funnelKey,
    panelSpec,
    artifacts,
    backend: "native",
    model: process.env.PANEL_SIM_MODEL ?? "claude-sonnet-4-6",
    nPersonas: n,
    iterations,
    seed,
    status: "running",
  });

  // Fire and forget — N Sonnet CLI calls take minutes; the pane polls status.
  void (async () => {
    try {
      const backend = new NativePanelBackend();
      const panel = await backend.runPanel({
        label: run.label,
        panelSpec,
        artifacts,
        funnelKey,
        n,
        seed,
        iterations,
      });
      savePanelResults(run.id, panel);
      const mc = monteCarlo(panel, iterations, seed);
      const agg = aggregate(panel);
      const reportMd = renderReportMd({
        label: run.label,
        funnelKey,
        backend: "native",
        panel,
        mc,
        agg,
      });
      const decision = createDecision({
        userEmail: run.userEmail,
        question: `Panel-sim "${run.label}": ${panel.length} personas complete. Adopt the report's findings?`,
        contextType: "panel_sim",
        contextId: run.id,
        options: ["Adopt findings / revise artifact", "Proceed as-is", "Re-run with changes", "Dismiss"],
        recommendedReason: "Advisory simulation — review the report before deciding.",
        actionKind: "none",
      });
      savePanelReport({ runId: run.id, aggregate: agg, monteCarlo: mc, reportMd, decisionId: decision.id });
      setPanelRunStatus(run.id, "complete");
    } catch (err) {
      setPanelRunStatus(run.id, "failed", err instanceof Error ? err.message : String(err));
    }
  })();

  return Response.json({ run }, { status: 202 });
}
