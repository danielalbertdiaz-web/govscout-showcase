/**
 * Panel-Sim CLI runner (spec: GOVSCOUT_PANEL_SIM_SPEC.md).
 *
 * Fresh run (drives the local `claude` CLI, Sonnet, N persona calls):
 *   node --import tsx scripts/panel-sim.mts \
 *     --artifact data/fixtures/panel/cover-note-APPROVED-PENDING-2026-07-26.md \
 *     --artifact data/fixtures/panel/deck-concept-summary.md \
 *     --panel <panel-spec.md> --n 16 --funnel coldemail-deck --label "my run"
 *
 * Ingest an already-run panel report (no LLM calls — parses the walkthrough
 * markdown into ps_* tables; this is how the 2026-07-26 health-officer panel
 * is seeded as run #1):
 *   node --import tsx scripts/panel-sim.mts \
 *     --ingest data/fixtures/panel/panel-simulation-2026-07-26.md \
 *     --json data/sim-runs/2026-07-26-health-officer-panel.json \
 *     --label "Health-officer cover note + deck (2026-07-26)"
 *
 * Every run: Monte Carlo (deterministic, seeded) → aggregate → report md into
 * data/sim-runs/ → filed as an advisory Decision (human makes the call).
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import {
  FUNNELS,
  isFunnelKey,
  aggregate,
  legacyToPanel,
  monteCarlo,
  parseLegacyPanelReport,
  renderReportMd,
  type Artifact,
  type PersonaDecisions,
} from "../lib/panel-sim";
import { NativePanelBackend } from "../lib/panel-sim-native";
import {
  createPanelRun,
  savePanelReport,
  savePanelResults,
  setPanelRunStatus,
} from "../lib/panel-sim-store";
import { createDecision } from "../lib/decisions";

const OWNER = "hello@govscout.ai";

type Args = {
  artifacts: string[];
  panel: string | null;
  ingest: string | null;
  json: string | null;
  n: number;
  funnel: string;
  label: string | null;
  seed: number;
  iterations: number;
  model: string | null;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    artifacts: [],
    panel: null,
    ingest: null,
    json: null,
    n: 16,
    funnel: "coldemail-deck",
    label: null,
    seed: 42,
    iterations: 1000,
    model: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i] ?? "";
    if (k === "--artifact") a.artifacts.push(next());
    else if (k === "--panel") a.panel = next();
    else if (k === "--ingest") a.ingest = next();
    else if (k === "--json") a.json = next();
    else if (k === "--n") a.n = Number(next()) || 16;
    else if (k === "--funnel") a.funnel = next();
    else if (k === "--label") a.label = next();
    else if (k === "--seed") a.seed = Number(next()) || 42;
    else if (k === "--iterations") a.iterations = Number(next()) || 1000;
    else if (k === "--model") a.model = next();
    else if (k === "--help" || k === "-h") a.help = true;
  }
  return a;
}

function usage(): void {
  console.log(
    [
      "panel-sim — reaction-panel / Monte Carlo simulation over artifacts",
      "",
      "Fresh run:",
      "  --artifact <file>   artifact to test (repeatable: cover note, deck summary, …)",
      "  --panel <file>      panel demographic spec (markdown/text)",
      "  --n <int>           personas (default 16)",
      "  --funnel <key>      " + Object.keys(FUNNELS).join(" | ") + " (default coldemail-deck)",
      "  --label <text>      run label",
      "  --seed <int>        Monte Carlo seed (default 42)",
      "  --iterations <int>  Monte Carlo iterations (default 1000)",
      "  --model <id>        persona model (default claude-sonnet-4-6 / $PANEL_SIM_MODEL)",
      "",
      "Ingest an existing panel report (no LLM calls):",
      "  --ingest <report.md>  walkthrough report (16-persona format)",
      "  --json <run.json>     optional legacy run record; aggregates preserved verbatim",
      "",
      "Every run lands in ps_* tables + data/sim-runs/<id>-report.md and is filed",
      "as an advisory Decision. Exit 0 on success.",
    ].join("\n"),
  );
}

async function finishRun(input: {
  runId: string;
  label: string;
  funnelKey: string;
  backend: string;
  panel: PersonaDecisions[];
  seed: number;
  iterations: number;
  sourceNote?: string | null;
  sourceAggregates?: Record<string, unknown> | null;
}): Promise<void> {
  savePanelResults(input.runId, input.panel);
  const mc = monteCarlo(input.panel, input.iterations, input.seed);
  const agg = aggregate(input.panel);
  const reportMd = renderReportMd({
    label: input.label,
    funnelKey: input.funnelKey,
    backend: input.backend,
    panel: input.panel,
    mc,
    agg,
    sourceNote: input.sourceNote,
  });

  // Advisory Decision — same trust gate as the MiroFish seam: a human makes
  // the call, the run never auto-gates anything.
  const inbox = mc.stages.find((s) => s.stage === "inbox_open");
  const action = mc.stages[mc.stages.length - 1];
  const decision = createDecision({
    userEmail: OWNER,
    question: `Panel-sim "${input.label}": ${input.panel.length} personas → ${
      inbox ? Math.round(inbox.mean * 100) + "% open, " : ""
    }${action ? Math.round(action.mean * 100) + "% final action" : ""}. Adopt the report's findings?`,
    contextType: "panel_sim",
    contextId: input.runId,
    options: ["Adopt findings / revise artifact", "Proceed as-is", "Re-run with changes", "Dismiss"],
    recommendedOption: null,
    recommendedReason: "Advisory simulation — review the report before deciding.",
    actionKind: "none",
  });

  const stored = savePanelReport({
    runId: input.runId,
    aggregate: input.sourceAggregates ? { ...agg, sourceAggregates: input.sourceAggregates } as never : agg,
    monteCarlo: mc,
    reportMd,
    decisionId: decision.id,
  });
  setPanelRunStatus(input.runId, "complete");

  const outDir = path.join(process.cwd(), "data", "sim-runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `panel-${input.runId}-report.md`);
  writeFileSync(outPath, reportMd);

  console.log(`\n=== Panel-sim complete — ${input.label} ===`);
  for (const s of mc.stages) {
    const label = FUNNELS[input.funnelKey]?.find((f) => f.key === s.stage)?.label ?? s.stage;
    console.log(
      `  ${label.padEnd(22)} ${(s.mean * 100).toFixed(1)}%  (95%: ${(s.ci95[0] * 100).toFixed(0)}–${(s.ci95[1] * 100).toFixed(0)}%)`,
    );
  }
  console.log(`  run:      ${input.runId}`);
  console.log(`  report:   ${outPath}`);
  console.log(`  decision: ${stored.decisionId} (advisory — resolve it in /decisions)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!isFunnelKey(args.funnel)) {
    console.error(`unknown funnel "${args.funnel}" — known: ${Object.keys(FUNNELS).join(", ")}`);
    process.exit(1);
  }

  if (args.ingest) {
    // ---- Ingest mode: parse an already-run panel report, no LLM calls. ----
    const md = readFileSync(args.ingest, "utf8");
    const legacy = parseLegacyPanelReport(md);
    if (legacy.length === 0) {
      console.error(`no personas parsed from ${args.ingest} — is it a walkthrough-format report?`);
      process.exit(1);
    }
    const legacyJson = args.json
      ? (JSON.parse(readFileSync(args.json, "utf8")) as Record<string, unknown>)
      : null;
    const label =
      args.label ??
      (legacyJson?.id ? String(legacyJson.id) : path.basename(args.ingest, ".md"));
    const run = createPanelRun({
      userEmail: OWNER,
      label,
      funnelKey: args.funnel,
      panelSpec: legacyJson?.subject ? JSON.stringify(legacyJson.subject) : null,
      artifacts: [{ name: path.basename(args.ingest), content: md, path: args.ingest }],
      backend: "ingest",
      model: null,
      nPersonas: legacy.length,
      iterations: args.iterations,
      seed: args.seed,
      status: "running",
      sourceNote: `Ingested from ${args.ingest}${args.json ? ` + ${args.json}` : ""} (non-inbox stage probabilities derived from narrative; see detail_json flags)`,
    });
    try {
      await finishRun({
        runId: run.id,
        label,
        funnelKey: args.funnel,
        backend: "ingest",
        panel: legacyToPanel(legacy),
        seed: args.seed,
        iterations: args.iterations,
        sourceNote: run.sourceNote,
        sourceAggregates:
          legacyJson && typeof legacyJson.aggregates === "object"
            ? {
                aggregates: legacyJson.aggregates,
                verdicts: legacyJson.verdicts ?? null,
                concept_ranking: legacyJson.concept_ranking ?? null,
                top_revisions: legacyJson.top_revisions ?? null,
                structural_risk: legacyJson.structural_risk ?? null,
              }
            : null,
      });
    } catch (err) {
      setPanelRunStatus(run.id, "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
    return;
  }

  // ---- Fresh run mode: LLM personas via the native backend. ----
  if (args.artifacts.length === 0 || !args.panel) {
    usage();
    console.error("\nerror: fresh runs need at least one --artifact and a --panel spec (or use --ingest)");
    process.exit(1);
  }
  const artifacts: Artifact[] = args.artifacts.map((p) => ({
    name: path.basename(p),
    content: readFileSync(p, "utf8"),
  }));
  const panelSpec = readFileSync(args.panel, "utf8");
  const label = args.label ?? `${artifacts[0].name} × ${args.n} personas`;

  const backend = new NativePanelBackend({
    model: args.model ?? undefined,
    onProgress: (m) => console.log(`  ${m}`),
  });
  const run = createPanelRun({
    userEmail: OWNER,
    label,
    funnelKey: args.funnel,
    panelSpec,
    artifacts: args.artifacts.map((p, i) => ({ ...artifacts[i], path: p })),
    backend: backend.id,
    model: args.model ?? process.env.PANEL_SIM_MODEL ?? "claude-sonnet-4-6",
    nPersonas: args.n,
    iterations: args.iterations,
    seed: args.seed,
    status: "running",
  });
  console.log(`run ${run.id} — ${label} (${args.n} personas, funnel ${args.funnel})`);
  try {
    const panel = await backend.runPanel({
      label,
      panelSpec,
      artifacts,
      funnelKey: args.funnel,
      n: args.n,
      seed: args.seed,
      iterations: args.iterations,
    });
    await finishRun({
      runId: run.id,
      label,
      funnelKey: args.funnel,
      backend: backend.id,
      panel,
      seed: args.seed,
      iterations: args.iterations,
    });
  } catch (err) {
    setPanelRunStatus(run.id, "failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

main().catch((err) => {
  console.error("panel-sim failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
