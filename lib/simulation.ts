// M1 — MiroFish grant-competition simulator seam (spec:
// ~/Desktop/GOVSCOUT_MIROFISH_INTEGRATION.md).
//
// MiroFish war-games a federal review panel: feed it the NOFO + competitive
// landscape + Acme's capability statement, it simulates reviewers deliberating
// over competing applicants, and reports a win probability + the weaknesses
// the panel would flag. The output is a GO/NO-GO signal BEFORE committing
// 40–80 hours to an application.
//
// Dark seam: MIROFISH_BASE_URL unset → unavailable, nothing calls out. The
// pure pieces (bundle assembly, prediction-requirement template, report
// parsing) are unit-tested; the HTTP driver is the thin impure shell.
//
// TRUST GATE (per the spec's own risk table): predictions are advisory-only
// until 3 backtests against known outcomes pass — verdicts land as Decisions
// for a human, never as automatic no-gos.

export const MIROFISH_DEFAULT_URL = "http://localhost:5001";

export function simulationConfigured(): boolean {
  return Boolean(process.env.MIROFISH_BASE_URL?.trim());
}

function baseUrl(): string {
  return (process.env.MIROFISH_BASE_URL?.trim() || MIROFISH_DEFAULT_URL).replace(/\/$/, "");
}

// ---- Pure: input bundle ----------------------------------------------------

export type SimulationBundle = {
  nofoTitle: string;
  nofoText: string;
  capabilityStatement: string;
  /** Known competitors / incumbents, one line each. Empty = generic field. */
  competitiveLandscape: string[];
  reviewers?: number;
  applicants?: number;
};

/** The prediction-requirement string MiroFish receives (spec Phase 2). */
export function buildPredictionRequirement(b: SimulationBundle): string {
  const reviewers = b.reviewers ?? 5;
  const applicants = b.applicants ?? Math.max(3, b.competitiveLandscape.length + 1);
  return [
    `Simulate a federal grant review panel evaluating applications for "${b.nofoTitle}".`,
    `The panel consists of ${reviewers} reviewers with domain expertise drawn from the NOFO's evaluation criteria.`,
    `Evaluate ${applicants} competing applicants including Acme Consulting Group LLC.`,
    `Score each applicant on the published evaluation criteria.`,
    `Predict the likelihood (as a percentage) of each applicant being selected for award.`,
    `Identify specific weaknesses in Acme Consulting's application that the review panel would flag.`,
    `Recommend positioning adjustments.`,
  ].join(" ");
}

/** Assemble the markdown document bundle MiroFish ingests. */
export function assembleBundleDocuments(b: SimulationBundle): { name: string; content: string }[] {
  return [
    { name: "01-nofo.md", content: `# NOFO: ${b.nofoTitle}\n\n${b.nofoText}` },
    { name: "02-el-capability.md", content: `# Acme Consulting Group — Capability Statement\n\n${b.capabilityStatement}` },
    {
      name: "03-competitive-landscape.md",
      content:
        `# Competitive Landscape\n\n` +
        (b.competitiveLandscape.length
          ? b.competitiveLandscape.map((c) => `- ${c}`).join("\n")
          : "- No named incumbents known; assume a typical field of regional non-profits and national consultancies."),
    },
  ];
}

// ---- Pure: report parsing ---------------------------------------------------

export type SimulationVerdict = {
  /** 0–100, null when the report carries no parseable probability. */
  winProbability: number | null;
  weaknesses: string[];
  recommendations: string[];
  reportExcerpt: string;
};

/**
 * Pull the structured verdict out of a MiroFish prediction report (markdown).
 * Tolerant: missing sections degrade to empty rather than throwing.
 */
export function parsePredictionReport(markdown: string): SimulationVerdict {
  const md = markdown ?? "";

  // Win probability — precedence order (learned from real run-3 output, where
  // each applicant's % sits on its own ranking row and Acme is ranked LAST):
  //   1. any Acme-mentioning line that itself carries a % ("Acme Consulting…: 25%
  //      likelihood") — the first Acme mention is often narrative with no number,
  //      so scan ALL Acme lines, not just the first;
  //   2. an explicit range near an Acme mention ("estimated… **15-25%**") → use
  //      the midpoint;
  //   3. any % in the doc (last resort — may belong to a competitor).
  let winProbability: number | null = null;
  const lines = md.split(/\r?\n/);
  const pctOf = (hay: string): number | null => {
    const pct = hay.match(/(\d{1,3})(?:\.\d+)?\s*%/);
    if (!pct) return null;
    const v = Number(pct[1]);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  };
  // A range ("15-25%") must be recognized BEFORE the plain-percent regex,
  // which would otherwise half-match it as "25%".
  const probeLine = (hay: string): number | null => {
    const range = hay.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})\s*%/);
    if (range) {
      const mid = Math.round((Number(range[1]) + Number(range[2])) / 2);
      if (mid >= 0 && mid <= 100) return mid;
    }
    return pctOf(hay);
  };
  const elLines = lines.filter((l) => /acme consulting/i.test(l));
  for (const l of elLines) {
    const v = probeLine(l);
    if (v != null) {
      winProbability = v;
      break;
    }
  }
  if (winProbability == null) {
    for (let i = 0; i < lines.length; i++) {
      if (!/acme consulting/i.test(lines[i])) continue;
      const v = probeLine(lines.slice(Math.max(0, i - 2), i + 3).join("\n"));
      if (v != null) {
        winProbability = v;
        break;
      }
    }
  }
  if (winProbability == null) winProbability = pctOf(md);

  const section = (names: string[]): string[] => {
    // Headings are verbose in practice ("Acme Consulting Group LLC's Application
    // Weaknesses and Award Probability") — match CONTAINS, not starts-with.
    const re = new RegExp(`^#{1,4}[^\\n]*(?:${names.join("|")})`, "im");
    const m = re.exec(md);
    if (!m) return [];
    const rest = md.slice(m.index + m[0].length);
    const end = rest.search(/^#{1,4}\s/m);
    const body = end >= 0 ? rest.slice(0, end) : rest;
    const allLines = body.split(/\r?\n/).map((l) => l.trim());
    // Prefer bullet items when the section has them; fall back to prose lines.
    const bullets = allLines
      .filter((l) => /^[-*•]|\d+[.)]/.test(l))
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim());
    const pool = bullets.length >= 2 ? bullets : allLines.map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim());
    return pool
      .filter((l) => l.length > 8)
      .filter((l) => !/\*\*$/.test(l)) // a line ENDING in ** is a bold sub-header, not an item
      .map((l) => l.replace(/\*\*/g, ""))
      .slice(0, 8);
  };

  return {
    winProbability,
    weaknesses: section(["weakness", "weaknesses", "risks", "concerns"]),
    recommendations: section(["recommendation", "recommendations", "positioning", "adjustments"]),
    reportExcerpt: md.slice(0, 2_000),
  };
}

// ---- Impure: the MiroFish API driver ----------------------------------------

async function api(path: string, init?: RequestInit, timeoutMs = 60_000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Accept-Language drives MiroFish's locale (backend/app/utils/locale.py
    // defaults to zh) — run 2's report came back in Chinese without this.
    const headers = { "accept-language": "en", ...(init?.headers ?? {}) };
    const res = await fetch(`${baseUrl()}${path}`, { ...init, headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`MiroFish ${path} → HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

export type SimulationRunResult = {
  ok: boolean;
  verdict: SimulationVerdict | null;
  error: string | null;
  graphId?: string;
  simulationId?: string;
};

function pick(obj: unknown, keys: string[]): string {
  const o = (obj && typeof obj === "object" ? obj : {}) as Record<string, unknown>;
  const data = (o.data && typeof o.data === "object" ? o.data : o) as Record<string, unknown>;
  for (const k of keys) {
    const v = data[k] ?? o[k];
    if (v != null && String(v).length > 0) return String(v);
  }
  return "";
}

async function poll(
  path: string,
  isDone: (body: Record<string, unknown>) => boolean,
  isFailed: (body: Record<string, unknown>) => boolean,
  budgetMs: number,
  cadenceMs = 15_000,
  // Some MiroFish status checks are POSTs with a JSON body (prepare/status).
  init?: RequestInit,
): Promise<{ done: boolean; last: Record<string, unknown> }> {
  const deadline = Date.now() + budgetMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = (await api(path, init).catch(() => ({}))) as Record<string, unknown>;
    if (isDone(last)) return { done: true, last };
    if (isFailed(last)) return { done: false, last };
    await new Promise((r) => setTimeout(r, cadenceMs));
  }
  return { done: false, last };
}

const statusOf = (b: Record<string, unknown>): string => {
  const d = (b.data && typeof b.data === "object" ? b.data : b) as Record<string, unknown>;
  return String(d.status ?? d.state ?? b.status ?? "").toLowerCase();
};
const DONE_STATES = ["complete", "completed", "finished", "done", "success"];
const FAIL_STATES = ["failed", "error", "cancelled"];

/**
 * Drive the full MiroFish pipeline against its REAL API (contracts read from
 * the cloned source, live-wired 2026-06-11):
 *   1. POST /api/graph/ontology/generate  (multipart files + simulation_requirement) → project_id
 *   2. POST /api/graph/build              {project_id} → task → poll /api/graph/task/<id>
 *   3. POST /api/simulation/create        {project_id} → simulation_id (status "created")
 *   4. POST /api/simulation/prepare       {simulation_id} → poll POST /prepare/status until ready
 *   5. POST /api/simulation/start         {simulation_id} → poll GET /<id>/run-status until completed
 *   6. POST /api/report/generate {simulation_id} → poll /api/report/check/<sim> → GET /api/report/<id>
 *
 * First live run (sim_a5e3b9a2a9ea) died in "created": prepare was being
 * called BEFORE create (it requires the simulation_id create returns) and
 * /start was never called at all — create only registers a record.
 */
export async function runGrantSimulation(b: SimulationBundle): Promise<SimulationRunResult> {
  if (!simulationConfigured()) return { ok: false, verdict: null, error: "not_configured" };
  try {
    // 1. Upload bundle + requirement → project.
    const form = new FormData();
    for (const doc of assembleBundleDocuments(b)) {
      form.append("files", new Blob([doc.content], { type: "text/markdown" }), doc.name);
    }
    form.append("simulation_requirement", buildPredictionRequirement(b));
    form.append("project_name", `govscout:${b.nofoTitle.slice(0, 60)}`);
    const created = (await api("/api/graph/ontology/generate", { method: "POST", body: form }, 300_000)) as Record<string, unknown>;
    const projectId = pick(created, ["project_id", "projectId", "id"]);
    if (!projectId) return { ok: false, verdict: null, error: `no project_id in ontology response: ${JSON.stringify(created).slice(0, 160)}` };

    // 2. Build the entity graph (async task).
    const build = (await api("/api/graph/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    }, 120_000)) as Record<string, unknown>;
    const taskId = pick(build, ["task_id", "taskId"]);
    if (taskId) {
      const t = await poll(`/api/graph/task/${taskId}`, (x) => DONE_STATES.includes(statusOf(x)), (x) => FAIL_STATES.includes(statusOf(x)), 20 * 60_000);
      if (!t.done) return { ok: false, verdict: null, error: `graph build did not complete: ${statusOf(t.last) || "timeout"}` };
    }

    // 3. Create the simulation record (status "created" — nothing runs yet).
    const sim = (await api("/api/simulation/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: projectId }),
    }, 300_000)) as Record<string, unknown>;
    const simulationId = pick(sim, ["simulation_id", "simulationId", "id"]);
    if (!simulationId) return { ok: false, verdict: null, error: `no simulation_id: ${JSON.stringify(sim).slice(0, 160)}` };

    // 4. Prepare: LLM generates agent profiles + config (async). prepare/status
    //    is a POST that takes the simulation_id and reports ready/progress.
    await api("/api/simulation/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ simulation_id: simulationId }),
    }, 120_000);
    const prepReady = (x: Record<string, unknown>) =>
      ["ready", "completed"].includes(statusOf(x)) || pick(x, ["already_prepared"]) === "true";
    const prepped = await poll(
      `/api/simulation/prepare/status`,
      prepReady,
      (x) => FAIL_STATES.includes(statusOf(x)),
      20 * 60_000,
      10_000,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ simulation_id: simulationId }) },
    );
    if (!prepped.done) {
      return { ok: false, verdict: null, error: `prepare ended in "${statusOf(prepped.last) || "timeout"}"`, simulationId };
    }

    // 5. Start the swarm, then poll run-status. max_rounds bounds cost/time.
    await api("/api/simulation/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ simulation_id: simulationId, platform: "parallel", max_rounds: 40 }),
    }, 120_000);
    const runnerOf = (x: Record<string, unknown>) => String(pick(x, ["runner_status"]) ?? statusOf(x)).toLowerCase();
    const s = await poll(
      `/api/simulation/${simulationId}/run-status`,
      (x) => runnerOf(x) === "completed",
      (x) => ["failed", "stopped"].includes(runnerOf(x)),
      45 * 60_000,
      20_000,
    );
    if (!s.done) return { ok: false, verdict: null, error: `simulation ended in "${runnerOf(s.last) || "timeout"}"`, simulationId };

    // 6. Generate the prediction report, poll, download markdown.
    await api("/api/report/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ simulation_id: simulationId }),
    }, 120_000);
    // report/check returns a report_id as soon as generation STARTS — run 2
    // grabbed the report while it was still "planning" (empty content). Wait
    // for report_status === "completed" before downloading.
    const rep = await poll(
      `/api/report/check/${simulationId}`,
      (x) => pick(x, ["report_status"]) === "completed",
      (x) => pick(x, ["report_status"]) === "failed",
      25 * 60_000,
    );
    const reportId = pick(rep.last, ["report_id", "reportId"]);
    if (!rep.done || !reportId) {
      return { ok: false, verdict: null, error: `report never completed (status: ${pick(rep.last, ["report_status"]) || "timeout"})`, simulationId };
    }
    const body = (await api(`/api/report/${reportId}`)) as Record<string, unknown>;
    const reportMd = pick(body, ["markdown_content", "content", "markdown", "report", "text"]) || JSON.stringify(body);

    return { ok: true, verdict: parsePredictionReport(reportMd), error: null, simulationId };
  } catch (err) {
    return { ok: false, verdict: null, error: err instanceof Error ? err.message : String(err) };
  }
}
