// Panel-Sim persistence — the impure SQLite layer over the ps_* tables
// (migration 031). The pure core (lib/panel-sim.ts) knows nothing about the
// database; this file owns rows ↔ types and nothing else.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import {
  FUNNELS,
  type AggregateReport,
  type Artifact,
  type MonteCarloResult,
  type Persona,
  type PersonaDecisions,
  type StageDecision,
} from "./panel-sim";

export type PanelRunStatus = "created" | "running" | "complete" | "failed";

export type PanelRunRecord = {
  id: string;
  userEmail: string;
  label: string;
  funnel: string;
  funnelStages: string[];
  panelSpec: string | null;
  artifacts: { name: string; path: string | null; chars: number }[];
  backend: string;
  model: string | null;
  nPersonas: number;
  iterations: number;
  seed: number;
  status: PanelRunStatus;
  error: string | null;
  sourceNote: string | null;
  createdAt: number;
  updatedAt: number;
};

type RunRow = {
  id: string;
  user_email: string;
  label: string;
  funnel: string;
  funnel_stages_json: string;
  panel_spec: string | null;
  artifacts_json: string;
  backend: string;
  model: string | null;
  n_personas: number;
  iterations: number;
  seed: number;
  status: string;
  error: string | null;
  source_note: string | null;
  created_at: number;
  updated_at: number;
};

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToRun(r: RunRow): PanelRunRecord {
  const status: PanelRunStatus = ["created", "running", "complete", "failed"].includes(r.status)
    ? (r.status as PanelRunStatus)
    : "created";
  return {
    id: r.id,
    userEmail: r.user_email,
    label: r.label,
    funnel: r.funnel,
    funnelStages: safeParse<string[]>(r.funnel_stages_json, []),
    panelSpec: r.panel_spec,
    artifacts: safeParse<PanelRunRecord["artifacts"]>(r.artifacts_json, []),
    backend: r.backend,
    model: r.model,
    nPersonas: Number(r.n_personas),
    iterations: Number(r.iterations),
    seed: Number(r.seed),
    status,
    error: r.error,
    sourceNote: r.source_note,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export type CreatePanelRunInput = {
  userEmail: string;
  label: string;
  funnelKey: string;
  panelSpec?: string | null;
  artifacts: (Artifact & { path?: string | null })[];
  backend: string;
  model?: string | null;
  nPersonas: number;
  iterations: number;
  seed: number;
  status?: PanelRunStatus;
  sourceNote?: string | null;
};

export function createPanelRun(input: CreatePanelRunInput): PanelRunRecord {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const stages = (FUNNELS[input.funnelKey] ?? []).map((s) => s.key);
  db.prepare(
    `INSERT INTO ps_runs (
       id, user_email, label, funnel, funnel_stages_json, panel_spec, artifacts_json,
       backend, model, n_personas, iterations, seed, status, source_note, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userEmail,
    input.label,
    input.funnelKey,
    JSON.stringify(stages),
    input.panelSpec ?? null,
    JSON.stringify(
      input.artifacts.map((a) => ({ name: a.name, path: a.path ?? null, chars: a.content.length })),
    ),
    input.backend,
    input.model ?? null,
    input.nPersonas,
    input.iterations,
    input.seed,
    input.status ?? "created",
    input.sourceNote ?? null,
    now,
    now,
  );
  return getPanelRun(id)!;
}

export function setPanelRunStatus(id: string, status: PanelRunStatus, error?: string | null): void {
  getDb()
    .prepare(`UPDATE ps_runs SET status = ?, error = ?, updated_at = ? WHERE id = ?`)
    .run(status, error ?? null, Date.now(), id);
}

export function getPanelRun(id: string): PanelRunRecord | null {
  const row = getDb().prepare(`SELECT * FROM ps_runs WHERE id = ?`).get(id) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listPanelRuns(userEmail: string, limit = 50): PanelRunRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM ps_runs WHERE user_email = ? ORDER BY created_at DESC LIMIT ?`)
    .all(userEmail, Math.min(Math.max(limit, 1), 200)) as RunRow[];
  return rows.map(rowToRun);
}

// ---- Personas + decisions ---------------------------------------------------

export function savePanelResults(runId: string, panel: PersonaDecisions[]): void {
  const db = getDb();
  const now = Date.now();
  const insPersona = db.prepare(
    `INSERT INTO ps_personas (id, run_id, idx, name, role, jurisdiction, profile, traits_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insDecision = db.prepare(
    `INSERT INTO ps_stage_decisions (id, run_id, persona_id, stage, stage_idx, probability, verdict, verbatim, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const pd of panel) {
    const personaId = randomUUID();
    insPersona.run(
      personaId,
      runId,
      pd.persona.idx,
      pd.persona.name,
      pd.persona.role,
      pd.persona.jurisdiction,
      pd.persona.profile,
      JSON.stringify(pd.persona.traits ?? {}),
      now,
    );
    for (const d of pd.decisions) {
      insDecision.run(
        randomUUID(),
        runId,
        personaId,
        d.stage,
        d.stageIdx,
        d.probability,
        d.verdict,
        d.verbatim,
        d.detail ? JSON.stringify(d.detail) : null,
        now,
      );
    }
  }
  getDb()
    .prepare(`UPDATE ps_runs SET n_personas = ?, updated_at = ? WHERE id = ?`)
    .run(panel.length, now, runId);
}

export function loadPanelResults(runId: string): PersonaDecisions[] {
  const db = getDb();
  const personas = db
    .prepare(`SELECT * FROM ps_personas WHERE run_id = ? ORDER BY idx ASC`)
    .all(runId) as {
    id: string;
    idx: number;
    name: string;
    role: string | null;
    jurisdiction: string | null;
    profile: string | null;
    traits_json: string | null;
  }[];
  const decisions = db
    .prepare(`SELECT * FROM ps_stage_decisions WHERE run_id = ? ORDER BY stage_idx ASC`)
    .all(runId) as {
    persona_id: string;
    stage: string;
    stage_idx: number;
    probability: number;
    verdict: string | null;
    verbatim: string | null;
    detail_json: string | null;
  }[];
  const byPersona = new Map<string, StageDecision[]>();
  for (const d of decisions) {
    const list = byPersona.get(d.persona_id) ?? [];
    list.push({
      stage: d.stage,
      stageIdx: Number(d.stage_idx),
      probability: Number(d.probability),
      verdict: d.verdict,
      verbatim: d.verbatim,
      detail: safeParse<Record<string, unknown> | null>(d.detail_json, null),
    });
    byPersona.set(d.persona_id, list);
  }
  return personas.map((p) => {
    const persona: Persona = {
      idx: Number(p.idx),
      name: p.name,
      role: p.role,
      jurisdiction: p.jurisdiction,
      profile: p.profile ?? "",
      traits: safeParse<Record<string, unknown>>(p.traits_json, {}),
    };
    return { persona, decisions: byPersona.get(p.id) ?? [] };
  });
}

// ---- Reports ----------------------------------------------------------------

export type PanelReportRecord = {
  id: string;
  runId: string;
  aggregate: AggregateReport | null;
  monteCarlo: MonteCarloResult | null;
  reportMd: string | null;
  decisionId: string | null;
  createdAt: number;
};

export function savePanelReport(input: {
  runId: string;
  aggregate: AggregateReport;
  monteCarlo: MonteCarloResult;
  reportMd: string;
  decisionId?: string | null;
}): PanelReportRecord {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO ps_reports (id, run_id, aggregate_json, monte_carlo_json, report_md, decision_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       aggregate_json = excluded.aggregate_json,
       monte_carlo_json = excluded.monte_carlo_json,
       report_md = excluded.report_md,
       decision_id = COALESCE(excluded.decision_id, ps_reports.decision_id)`,
  ).run(
    // ON CONFLICT keeps the original id; the freshly generated one is only
    // used on first insert.
    id,
    input.runId,
    JSON.stringify(input.aggregate),
    JSON.stringify(input.monteCarlo),
    input.reportMd,
    input.decisionId ?? null,
    now,
  );
  return getPanelReport(input.runId)!;
}

export function getPanelReport(runId: string): PanelReportRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM ps_reports WHERE run_id = ?`)
    .get(runId) as
    | {
        id: string;
        run_id: string;
        aggregate_json: string;
        monte_carlo_json: string;
        report_md: string | null;
        decision_id: string | null;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    aggregate: safeParse<AggregateReport | null>(row.aggregate_json, null),
    monteCarlo: safeParse<MonteCarloResult | null>(row.monte_carlo_json, null),
    reportMd: row.report_md,
    decisionId: row.decision_id,
    createdAt: Number(row.created_at),
  };
}
