// Cron health model (Item 1.3).
//
// Makes invisible cron failures visible. The external OpenClaw cron runner
// (~/.openclaw/cron/) writes three things this module reads:
//   - jobs.json        — job definitions (name, schedule, enabled)
//   - jobs-state.json  — per-job run state (last/next run, status, error streak)
//   - runs/<id>.jsonl  — append-only run log ({ts, action, status, summary})
//
// This module classifies each cron as OK / STALE / FAILED / BLOCKED / DISABLED
// / ABANDONED (disabled while carrying a failure streak — a dark lane)
// and is the data source for the /cron-health dashboard. The classifier is a
// pure function so the status logic is unit-tested without touching the disk.
//
// OUT OF SCOPE here (lives in the external runner, not this repo): the
// cron-health.json writer, the once-per-stale-window Telegram alert, and the
// shared withScanFailProtection(cronFn) wrapper. See STATUS for the handoff.

import fs from "fs";
import os from "os";
import path from "path";

const CRON_DIR = path.join(os.homedir(), ".openclaw", "cron");
const JOBS_FILE = path.join(CRON_DIR, "jobs.json");
const STATE_FILE = path.join(CRON_DIR, "jobs-state.json");
const RUNS_DIR = path.join(CRON_DIR, "runs");

// Upstream-block signals in a failed run's summary. A blocked cron is NOT the
// same as a crashed one — it ran, but an upstream source refused it.
const BLOCK_PATTERN = /\b(blocked|upstream|forbidden|403|429|rate.?limit(?:ed)?|captcha|denied|unavailable)\b/i;

// The OpenClaw self-update restarts the gateway, which kills every job in
// flight; the scheduler records "error" for each of them. That is an
// infrastructure event, not evidence the job is broken — the 6AM maintenance
// job even sequences its own update last so the interruption lands AFTER its
// report is delivered. Anchored on the runner's exact phrasing so a job that
// genuinely fails while restarting a service it manages ("failed to restart
// nginx") still counts as failed.
const GATEWAY_RESTART_PATTERN = /interrupted by gateway restart/i;

/** Is this run-error text the scheduler's own gateway-restart interruption? */
export function isGatewayRestartInterruption(text: string | null | undefined): boolean {
  return text != null && GATEWAY_RESTART_PATTERN.test(text);
}

export type CronStatus = "ok" | "stale" | "failed" | "blocked" | "disabled" | "abandoned";

export type CronClassifyInput = {
  enabled: boolean;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  consecutiveErrors: number;
  /** Set when the latest failure looks like an upstream block. */
  blocked: { reason: string; atMs: number } | null;
  /**
   * True when the most recent run ended in a gateway-restart interruption
   * rather than a real failure. An interrupted last run must not drive the
   * job to `failed` — the streak in consecutiveErrors (already recomputed
   * with interruptions skipped) still can.
   */
  lastRunInterrupted?: boolean;
};

/**
 * Classify a cron's current health. Pure — no I/O — so it can be unit-tested
 * with fixtures. Priority: abandoned/disabled > blocked > failed > stale > ok.
 *
 * A disabled job with a failure streak is "abandoned", not "disabled": it was
 * switched off while failing, so the lane went dark rather than being retired
 * on purpose. The 2026-07-31 audit found four GovScout jobs in exactly this
 * state (up to 7 consecutive errors), rendered identically to deliberate offs.
 */
export function classifyCronStatus(
  i: CronClassifyInput,
  now: number,
): { status: CronStatus; reason: string } {
  if (!i.enabled) {
    if (i.consecutiveErrors > 0) {
      return {
        status: "abandoned",
        reason: `Disabled while failing (${i.consecutiveErrors} consecutive error${i.consecutiveErrors === 1 ? "" : "s"}) — this lane is dark.`,
      };
    }
    return { status: "disabled", reason: "Job disabled — not scheduled." };
  }
  if (i.blocked) return { status: "blocked", reason: `Upstream blocked: ${i.blocked.reason}` };

  const statusFailed =
    !i.lastRunInterrupted && i.lastRunStatus != null && i.lastRunStatus.toLowerCase() !== "ok";
  if (statusFailed || i.consecutiveErrors > 0) {
    const detail = statusFailed
      ? `last run "${i.lastRunStatus}"`
      : `${i.consecutiveErrors} consecutive error${i.consecutiveErrors === 1 ? "" : "s"}`;
    return { status: "failed", reason: `Cron failed (${detail}).` };
  }

  // Staleness: silent past 1.5x its expected interval. The expected interval is
  // derived from the runner's own next/last timestamps — no cron-expr parsing.
  if (i.lastRunAtMs != null && i.nextRunAtMs != null) {
    const interval = i.nextRunAtMs - i.lastRunAtMs;
    if (interval > 0 && now - i.lastRunAtMs > 1.5 * interval) {
      const overdueMin = Math.max(0, Math.round((now - i.nextRunAtMs) / 60_000));
      return { status: "stale", reason: `Silent past 1.5x interval (overdue ~${overdueMin}m).` };
    }
  }

  if (i.lastRunInterrupted) {
    return {
      status: "ok",
      reason: "Healthy — last run was interrupted by a gateway restart (not counted as a failure).",
    };
  }
  return { status: "ok", reason: "Healthy." };
}

/** Where a CronHealth row came from. Surfaced so "no data" is never mistaken for "healthy". */
export type CronSource = "sqlite" | "jsonl";

/**
 * Does this OpenClaw job read or write GovScout? (V4.1 §14.3)
 *
 * Pure and tested — the whole point of the unified view is that a GovScout-
 * touching job failing silently in OpenClaw shows up on GovScout's dashboard,
 * so the matcher must not quietly stop matching.
 *
 * Deliberately generous: a false positive puts one extra job on the dashboard,
 * a false negative hides a failing pipeline. The 2026-07-31 audit found
 * "Acme Consulting Grant Monitor - Weekly Pipeline" sitting at 4 consecutive
 * errors with nothing surfacing it anywhere.
 */

// Names of GovScout systems, artifacts, and the bid/grant sources it watches.
// These cannot appear in prose by coincidence, so they are matched against
// everything known about a job — including its prompt body and trigger script.
// That preserves the case the matcher exists for: a job whose name reveals
// nothing but whose prompt invokes scripts/fp-amendment-watch or writes to
// projects/govscout-v5.
const SPECIFIC_SIGNALS = [
  "govscout",
  "gov scout",
  "bid board",
  "bidboard",
  "track-l",
  "track l",
  "trackl",
  "nofo",
  "sam.gov",
  "sam gov",
  "ungm",
  "micro-sweep",
  "micro sweep",
  "micro-contract",
  "panel-sim",
  "panel sim",
  "solicitation",
  "rfp",
  "rfq",
  "rfi",
  "projects/govscout-v5",
  "fp-amendment",
  "scripts/fp",
];

// Ordinary English words that mark a job as GovScout's business when they say
// what the job IS (its name/description) but appear innocently in prompt prose
// (what the job might mention). 2026-08-04: "Daily 6AM: System Update + Skill
// Discovery" — an OpenClaw maintenance job — flipped the public health status
// to "failed" because its prompt's skill-search themes happened to contain
// "contract" and "procurement".
const GENERIC_SIGNALS = [
  "grant",
  "opportunit",
  "procurement",
  "contract",
  "award",
  "subcontract",
  "teaming",
  "settlement",
  "underspend",
  "foundation",
];

/**
 * Relevance is decided on what a job IS, not what it mentions.
 *
 * `identity` (name + description) is matched against every signal; `body`
 * (payload_message + trigger_script) only against the high-specificity ones,
 * so a prompt that merely mentions "procurement" does not become GovScout's
 * health problem.
 */
export function touchesGovScout(identity: string, body?: string): boolean {
  const id = identity.toLowerCase();
  if (SPECIFIC_SIGNALS.some((sig) => id.includes(sig))) return true;
  if (GENERIC_SIGNALS.some((sig) => id.includes(sig))) return true;
  if (body) {
    const b = body.toLowerCase();
    return SPECIFIC_SIGNALS.some((sig) => b.includes(sig));
  }
  return false;
}

/**
 * A block only counts if nothing has succeeded since.
 *
 * Both loaders find the most recent failure in the run log and check it for
 * block signals. Without this, a job that was rate-limited last week and has
 * run cleanly every day since still reports "blocked" forever — which is how
 * the first run of the unified view raised two false alarms against jobs whose
 * consecutive_errors were 0 and which had succeeded that same morning.
 *
 * An alerting system that cries wolf gets ignored, so stale blocks are dropped.
 */
export function resolveBlocked(
  blocked: { reason: string; atMs: number } | null,
  lastSuccessMs: number | null,
): { reason: string; atMs: number } | null {
  if (!blocked) return null;
  if (lastSuccessMs != null && lastSuccessMs >= blocked.atMs) return null;
  return blocked;
}

export type CronHealth = {
  id: string;
  name: string;
  enabled: boolean;
  scheduleExpr: string | null;
  tz: string | null;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  lastRunStatus: string | null;
  consecutiveErrors: number;
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  sinceLastSuccessMs: number | null;
  status: CronStatus;
  reason: string;
  /** Where this row was read from. */
  source: CronSource;
  /** True when the job reads or writes GovScout state (V4.1 §14.3). */
  govscoutRelevant: boolean;
  /** Last run duration, when the runner recorded one. */
  lastDurationMs: number | null;
  /** Runner's own error text for the last failure, truncated. Never a secret. */
  lastError: string | null;
  /** Set while a run is in flight. */
  runningSinceMs: number | null;
};

type JobsFile = {
  jobs?: Array<{
    id: string;
    name?: string;
    enabled?: boolean;
    schedule?: { expr?: string; tz?: string };
  }>;
};

type StateFile = {
  jobs?: Record<
    string,
    {
      state?: {
        nextRunAtMs?: number;
        lastRunAtMs?: number;
        lastRunStatus?: string;
        lastStatus?: string;
        consecutiveErrors?: number;
      };
    }
  >;
};

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// Scan a job's run log for the most recent success, the most recent failure
// (gateway-restart interruptions are neither), whether that latest failure
// looks like an upstream block, and the failure streak with interruptions
// skipped.
function readRunSignals(jobId: string): {
  lastSuccessMs: number | null;
  lastFailureMs: number | null;
  blocked: { reason: string; atMs: number } | null;
  effectiveConsecutiveErrors?: number;
  lastRunInterrupted?: boolean;
} {
  const file = path.join(RUNS_DIR, `${jobId}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { lastSuccessMs: null, lastFailureMs: null, blocked: null };
  }
  const finished: Array<{ ts: number; ok: boolean; interrupted: boolean; summary?: string }> = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec: { ts?: number; action?: string; status?: string; summary?: string };
    try {
      rec = JSON.parse(s);
    } catch {
      continue; // tolerate partially-flushed lines
    }
    if (rec.action !== "finished" || typeof rec.ts !== "number") continue;
    const ok = (rec.status ?? "").toLowerCase() === "ok";
    finished.push({
      ts: rec.ts,
      ok,
      interrupted: !ok && isGatewayRestartInterruption(rec.summary),
      summary: rec.summary,
    });
  }
  if (!finished.length) return { lastSuccessMs: null, lastFailureMs: null, blocked: null };

  finished.sort((a, b) => b.ts - a.ts); // newest first
  let lastSuccessMs: number | null = null;
  let lastFailureMs: number | null = null;
  let blocked: { reason: string; atMs: number } | null = null;
  let effectiveConsecutiveErrors = 0;
  let streakEnded = false;
  for (const r of finished) {
    if (r.ok) {
      streakEnded = true;
      if (lastSuccessMs == null) lastSuccessMs = r.ts;
    } else if (!r.interrupted) {
      if (!streakEnded) effectiveConsecutiveErrors++;
      if (lastFailureMs == null) {
        lastFailureMs = r.ts;
        const m = r.summary ? BLOCK_PATTERN.exec(r.summary) : null;
        blocked = m ? { reason: m[0], atMs: r.ts } : null;
      }
    }
  }
  return {
    lastSuccessMs,
    lastFailureMs,
    blocked,
    effectiveConsecutiveErrors,
    lastRunInterrupted: finished[0].interrupted,
  };
}

/**
 * Row shape from openclaw.sqlite `cron_jobs`. Only the columns we consume.
 */
type SqliteJobRow = {
  job_id: string;
  name: string | null;
  display_name: string | null;
  description: string | null;
  enabled: number;
  schedule_expr: string | null;
  schedule_kind: string | null;
  schedule_tz: string | null;
  last_run_at_ms: number | null;
  next_run_at_ms: number | null;
  running_at_ms: number | null;
  last_run_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  consecutive_errors: number | null;
  payload_message: string | null;
  trigger_script: string | null;
};

/**
 * Pure mapper: one cron_jobs row -> CronHealth. Split out so the sqlite shape
 * is testable without a database.
 */
export function sqliteRowToCronHealth(
  row: SqliteJobRow,
  runSignals: {
    lastSuccessMs: number | null;
    lastFailureMs: number | null;
    blocked: { reason: string; atMs: number } | null;
    /** Failure streak recomputed from the run log, gateway-restart interruptions skipped. */
    effectiveConsecutiveErrors?: number;
    /** True when the newest run-log entry is a gateway-restart interruption. */
    lastRunInterrupted?: boolean;
  },
  now: number,
): CronHealth {
  const enabled = row.enabled !== 0;
  const lastRunStatus = row.last_run_status ?? null;
  const lastSuccessMs =
    runSignals.lastSuccessMs ?? (lastRunStatus?.toLowerCase() === "ok" ? row.last_run_at_ms : null);

  // Without a run log, fall back to the row itself: an "error" last run whose
  // recorded error is the gateway-restart interruption is interrupted, and the
  // scheduler's counter (which counted that interruption) is discounted by one.
  const lastRunInterrupted =
    runSignals.lastRunInterrupted ??
    (lastRunStatus != null &&
      lastRunStatus.toLowerCase() !== "ok" &&
      isGatewayRestartInterruption(row.last_error));
  const consecutiveErrors =
    runSignals.effectiveConsecutiveErrors ??
    Math.max(0, (row.consecutive_errors ?? 0) - (lastRunInterrupted ? 1 : 0));

  const { status, reason } = classifyCronStatus(
    {
      enabled,
      lastRunAtMs: row.last_run_at_ms,
      nextRunAtMs: row.next_run_at_ms,
      lastRunStatus,
      consecutiveErrors,
      blocked: resolveBlocked(runSignals.blocked, lastSuccessMs),
      lastRunInterrupted,
    },
    now,
  );

  const name = row.display_name ?? row.name ?? row.job_id;
  const identity = [name, row.description].filter(Boolean).join(" ");
  const body = [row.payload_message, row.trigger_script].filter(Boolean).join(" ");

  return {
    id: row.job_id,
    name,
    enabled,
    scheduleExpr: row.schedule_expr ?? row.schedule_kind ?? null,
    tz: row.schedule_tz ?? null,
    lastRunAtMs: row.last_run_at_ms,
    nextRunAtMs: row.next_run_at_ms,
    lastRunStatus,
    consecutiveErrors,
    lastSuccessMs,
    lastFailureMs: runSignals.lastFailureMs,
    sinceLastSuccessMs: lastSuccessMs == null ? null : Math.max(0, now - lastSuccessMs),
    status,
    reason,
    source: "sqlite",
    govscoutRelevant: touchesGovScout(identity, body),
    lastDurationMs: row.last_duration_ms ?? null,
    lastError: row.last_error ? row.last_error.slice(0, 300) : null,
    runningSinceMs: row.running_at_ms ?? null,
  };
}

const OPENCLAW_STATE_DB = path.join(os.homedir(), ".openclaw", "state", "openclaw.sqlite");

/**
 * Read cron state from openclaw.sqlite.
 *
 * OpenClaw migrated its scheduler out of ~/.openclaw/cron/*.json into this
 * database; only .bak and .migrated files remain at the old paths. That is why
 * /cron-health showed nothing and the health probe reported "unknown" — the
 * module was reading a location the runner had abandoned.
 *
 * Opened read-only. GovScout observes the scheduler; it must never write to it.
 */
function loadCronHealthFromSqlite(now: number): CronHealth[] | null {
  if (!fs.existsSync(OPENCLAW_STATE_DB)) return null;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const Better = require("better-sqlite3");
    const db = new Better(OPENCLAW_STATE_DB, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT job_id, name, display_name, description, enabled, schedule_expr, schedule_kind,
                  schedule_tz, last_run_at_ms, next_run_at_ms, running_at_ms, last_run_status,
                  last_error, last_duration_ms, consecutive_errors, payload_message, trigger_script
             FROM cron_jobs`,
        )
        .all() as SqliteJobRow[];

      // Latest ok / latest non-ok per job, from the run log.
      const sigStmt = db.prepare(
        `SELECT status, ts, COALESCE(summary, error, '') AS text
           FROM cron_run_logs WHERE job_id = ? ORDER BY ts DESC LIMIT 200`,
      );

      return rows.map((row) => {
        const logRows = sigStmt.all(row.job_id) as Array<{ status: string | null; ts: number; text: string }>;
        let lastSuccessMs: number | null = null;
        let lastFailureMs: number | null = null;
        let blocked: { reason: string; atMs: number } | null = null;
        // Failure streak recomputed with gateway-restart interruptions being
        // transparent: they neither increment nor clear it (an interruption is
        // not evidence of failure, but not evidence of recovery either).
        let effectiveConsecutiveErrors = 0;
        let streakEnded = false;
        let lastRunInterrupted = false;
        for (const [idx, r] of logRows.entries()) {
          const ok = (r.status ?? "").toLowerCase() === "ok";
          const interrupted = !ok && isGatewayRestartInterruption(r.text);
          if (idx === 0) lastRunInterrupted = interrupted;
          if (ok) {
            streakEnded = true;
            if (lastSuccessMs == null) lastSuccessMs = r.ts;
          } else if (!interrupted) {
            if (!streakEnded) effectiveConsecutiveErrors++;
            if (lastFailureMs == null) {
              lastFailureMs = r.ts;
              const m = BLOCK_PATTERN.exec(r.text ?? "");
              blocked = m ? { reason: m[0], atMs: r.ts } : null;
            }
          }
          if (lastSuccessMs != null && lastFailureMs != null) break;
        }
        const runSignals = logRows.length
          ? { lastSuccessMs, lastFailureMs, blocked, effectiveConsecutiveErrors, lastRunInterrupted }
          : { lastSuccessMs, lastFailureMs, blocked }; // no log: let the mapper fall back to the row
        return sqliteRowToCronHealth(row, runSignals, now);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Load + classify health for every known cron. `now` is injectable for tests.
 *
 * Prefers openclaw.sqlite (the live scheduler) and falls back to the legacy
 * JSON files for installs that have not migrated.
 */
export function loadCronHealth(now: number = Date.now()): CronHealth[] {
  const fromSqlite = loadCronHealthFromSqlite(now);
  if (fromSqlite && fromSqlite.length) return fromSqlite;
  return loadCronHealthFromJson(now);
}

function loadCronHealthFromJson(now: number): CronHealth[] {
  const jobsFile = readJsonSafe<JobsFile>(JOBS_FILE);
  const stateFile = readJsonSafe<StateFile>(STATE_FILE);
  const jobs = jobsFile?.jobs ?? [];
  const stateMap = stateFile?.jobs ?? {};

  return jobs.map((job): CronHealth => {
    const state = stateMap[job.id]?.state ?? {};
    const runSignals = readRunSignals(job.id);
    const lastRunStatus = state.lastRunStatus ?? state.lastStatus ?? null;
    const lastRunAtMs = state.lastRunAtMs ?? null;
    // Prefer the run-log success timestamp; fall back to last run when it was ok.
    const lastSuccessMs =
      runSignals.lastSuccessMs ??
      (lastRunStatus?.toLowerCase() === "ok" ? lastRunAtMs : null);
    const consecutiveErrors =
      runSignals.effectiveConsecutiveErrors ?? state.consecutiveErrors ?? 0;

    const { status, reason } = classifyCronStatus(
      {
        enabled: job.enabled !== false,
        lastRunAtMs,
        nextRunAtMs: state.nextRunAtMs ?? null,
        lastRunStatus,
        consecutiveErrors,
        blocked: resolveBlocked(runSignals.blocked, lastSuccessMs),
        lastRunInterrupted: runSignals.lastRunInterrupted ?? false,
      },
      now,
    );

    return {
      id: job.id,
      name: job.name ?? job.id,
      enabled: job.enabled !== false,
      scheduleExpr: job.schedule?.expr ?? null,
      tz: job.schedule?.tz ?? null,
      lastRunAtMs,
      nextRunAtMs: state.nextRunAtMs ?? null,
      lastRunStatus,
      consecutiveErrors,
      lastSuccessMs,
      lastFailureMs: runSignals.lastFailureMs,
      sinceLastSuccessMs: lastSuccessMs == null ? null : Math.max(0, now - lastSuccessMs),
      status,
      reason,
      source: "jsonl",
      govscoutRelevant: touchesGovScout(job.name ?? job.id),
      lastDurationMs: null,
      lastError: null,
      runningSinceMs: null,
    };
  });
}
