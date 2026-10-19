// System health probes (V4.1 §14.2).
//
// The defect this exists for: on 2026-07-27 a build was produced but the
// production process was never restarted, so GovScout served a stale bundle
// for four days while emitting "Failed to find Server Action" on every
// request. Nothing noticed, because /api/health returned {ok:true} without
// looking at anything.
//
// So the important probe here is `build` — it compares the commit the running
// bundle was built from against the commit currently checked out. Everything
// else is supporting cast.
//
// Probes are deliberately cheap and non-mutating: no subprocess spawns, no
// network calls, no writes that survive the request. A health endpoint that is
// expensive or has side effects stops getting called.

import fs from "fs";
import path from "path";
import { getDb } from "./db";
import { loadCronHealth } from "./cron-health";

export type ProbeStatus = "ok" | "degraded" | "failed" | "unknown";

export type Probe = {
  name: string;
  status: ProbeStatus;
  detail: string;
  /** Extra structured context. Must never contain secret values. */
  meta?: Record<string, unknown>;
};

export type HealthReport = {
  ok: boolean;
  status: ProbeStatus;
  ts: number;
  probes: Probe[];
};

/** Where the deploy script records what it built. Absent on a hand-built tree. */
export const BUILD_META_PATH = path.join(process.cwd(), "build-meta.json");

export type BuildMeta = {
  commit: string;
  buildId: string;
  builtAt: string;
  deployedAt?: string;
  operator?: string;
};

export function readBuildMeta(): BuildMeta | null {
  try {
    return JSON.parse(fs.readFileSync(BUILD_META_PATH, "utf8")) as BuildMeta;
  } catch {
    return null;
  }
}

/** The commit currently checked out, read from .git without spawning git. */
export function readHeadCommit(cwd: string = process.cwd()): string | null {
  try {
    const head = fs.readFileSync(path.join(cwd, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head; // detached HEAD
    const ref = head.slice(4).trim();
    const refPath = path.join(cwd, ".git", ref);
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, "utf8").trim();
    // Packed refs fallback.
    const packed = fs.readFileSync(path.join(cwd, ".git", "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      if (line.endsWith(` ${ref}`)) return line.split(" ")[0];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure drift comparison, split out so it can be tested without a filesystem.
 * `null` head means we could not read git — that is "unknown", not "ok".
 */
export function compareBuildToSource(
  meta: BuildMeta | null,
  headCommit: string | null,
  runningBuildId: string | null,
): Probe {
  if (!meta) {
    return {
      name: "build",
      status: "unknown",
      detail: "No build-meta.json — this build was not produced by scripts/deploy.sh, so drift cannot be detected.",
    };
  }
  if (runningBuildId && meta.buildId !== runningBuildId) {
    return {
      name: "build",
      status: "failed",
      detail: `Running bundle ${runningBuildId} does not match the recorded build ${meta.buildId}. A build completed without a restart.`,
      meta: { recordedBuildId: meta.buildId, runningBuildId },
    };
  }
  if (!headCommit) {
    return {
      name: "build",
      status: "unknown",
      detail: "Could not read HEAD; drift not verifiable.",
      meta: { builtFrom: meta.commit },
    };
  }
  if (headCommit !== meta.commit) {
    return {
      name: "build",
      status: "degraded",
      detail: `Source has moved since the deployed build. Serving ${meta.commit.slice(0, 7)}, checked out ${headCommit.slice(0, 7)}. Run scripts/deploy.sh.`,
      meta: { builtFrom: meta.commit, headCommit, builtAt: meta.builtAt },
    };
  }
  return {
    name: "build",
    status: "ok",
    detail: `Serving ${meta.commit.slice(0, 7)}, built ${meta.builtAt}.`,
    meta: { commit: meta.commit, buildId: meta.buildId, builtAt: meta.builtAt },
  };
}

function probeBuild(): Probe {
  let runningBuildId: string | null = null;
  try {
    runningBuildId = fs.readFileSync(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    /* dev server has no BUILD_ID */
  }
  return compareBuildToSource(readBuildMeta(), readHeadCommit(), runningBuildId);
}

function probeDatabase(): Probe {
  try {
    const db = getDb();
    const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number };
    // Write probe against a temp table: proves the handle is writable without
    // touching real data or leaving anything behind when the connection closes.
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _health_probe (v INTEGER)");
    db.prepare("INSERT INTO _health_probe (v) VALUES (?)").run(1);
    db.exec("DROP TABLE _health_probe");
    return { name: "database", status: "ok", detail: `Readable and writable; ${row.n} tables.`, meta: { tables: row.n } };
  } catch (err) {
    return {
      name: "database",
      status: "failed",
      detail: `SQLite probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function probeClaudeCli(): Probe {
  const bin = process.env.CLAUDE_CLI_PATH;
  if (!bin) {
    return { name: "claude_cli", status: "degraded", detail: "CLAUDE_CLI_PATH unset; drafting falls back to PATH lookup." };
  }
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return { name: "claude_cli", status: "ok", detail: "CLI present and executable." };
  } catch {
    return { name: "claude_cli", status: "failed", detail: `CLAUDE_CLI_PATH is not executable: ${bin}` };
  }
}

/** Reports only whether config is present — never a key value or fragment. */
function probeExtractionConfig(): Probe {
  const missing = (["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL_EXTRACT"] as const).filter(
    (k) => !process.env[k]?.trim(),
  );
  if (missing.length) {
    return {
      name: "extraction_config",
      status: "degraded",
      detail: `NOFO extraction is not fully configured; missing: ${missing.join(", ")}.`,
    };
  }
  return { name: "extraction_config", status: "ok", detail: "Extraction credentials and model configured." };
}

function probeCrons(now: number): Probe {
  try {
    const all = loadCronHealth(now);
    if (!all.length) return { name: "crons", status: "unknown", detail: "No scheduler state available." };

    // A job unrelated to GovScout failing is real, but it is not GovScout's
    // health. Grade on the jobs that touch this system; report the rest.
    const jobs = all.filter((j) => j.govscoutRelevant);
    const failed = jobs.filter((j) => j.status === "failed");
    const stale = jobs.filter((j) => j.status === "stale");
    const blocked = jobs.filter((j) => j.status === "blocked");
    // Abandoned = disabled while failing. Nothing is actively breaking, but the
    // lane's coverage is gone — degraded, not failed.
    const abandoned = jobs.filter((j) => j.status === "abandoned");
    const meta = {
      source: all[0].source,
      total: all.length,
      govscoutRelevant: jobs.length,
      failed: failed.map((j) => j.id),
      stale: stale.map((j) => j.id),
      blocked: blocked.map((j) => j.id),
      abandoned: abandoned.map((j) => j.id),
      otherFailing: all.filter((j) => !j.govscoutRelevant && j.status === "failed").length,
    };

    if (failed.length) {
      return {
        name: "crons",
        status: "failed",
        detail: `${failed.length} GovScout job(s) failing: ${failed.map((j) => `${j.name} (${j.consecutiveErrors} consecutive)`).join("; ")}.`,
        meta,
      };
    }
    if (blocked.length || stale.length || abandoned.length) {
      const parts = [
        blocked.length ? `${blocked.length} blocked upstream: ${blocked.map((j) => j.name).join(", ")}` : "",
        stale.length ? `${stale.length} stale: ${stale.map((j) => j.name).join(", ")}` : "",
        abandoned.length
          ? `${abandoned.length} abandoned (disabled while failing): ${abandoned.map((j) => j.name).join(", ")}`
          : "",
      ].filter(Boolean);
      return { name: "crons", status: "degraded", detail: `${parts.join("; ")}.`, meta };
    }
    return {
      name: "crons",
      status: "ok",
      detail: `${jobs.length} GovScout job(s) healthy of ${all.length} scheduled.`,
      meta,
    };
  } catch (err) {
    return {
      name: "crons",
      status: "unknown",
      detail: `Scheduler state unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Only the automated backups count. Deploy-time and ad-hoc backups also land
// under ~/.openclaw/backups, and grading on those would let a dead
// com.govscout.backup job hide behind the last manual deploy.
const BACKUP_DIR = path.join(process.env.HOME ?? "", ".openclaw", "backups", "govscout-auto");
const BACKUP_STALE_MS = 36 * 60 * 60 * 1000; // daily job; 36h means it missed a run

function probeBackup(now: number): Probe {
  try {
    const entries = fs
      .readdirSync(BACKUP_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(BACKUP_DIR, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (!entries.length) {
      return { name: "backup", status: "failed", detail: "No automated backups found — is com.govscout.backup loaded?" };
    }
    const newest = entries[0];
    // A directory can exist without a usable snapshot in it.
    const dbFile = path.join(BACKUP_DIR, newest.name, "govscout.db");
    if (!fs.existsSync(dbFile)) {
      return { name: "backup", status: "failed", detail: `Newest backup ${newest.name} contains no govscout.db.` };
    }
    const ageMs = now - newest.mtime;
    const ageHours = Math.floor(ageMs / 3_600_000);
    const meta = { newest: newest.name, ageHours, retained: entries.length };
    if (ageMs > BACKUP_STALE_MS) {
      return {
        name: "backup",
        status: "degraded",
        detail: `Newest automated backup is ${ageHours}h old (${newest.name}) — the daily job may have stopped.`,
        meta,
      };
    }
    return { name: "backup", status: "ok", detail: `Backup ${ageHours}h old (${newest.name}), ${entries.length} retained.`, meta };
  } catch {
    return { name: "backup", status: "unknown", detail: "Automated backup directory unreadable." };
  }
}

/**
 * The UNAUTHENTICATED health payload — the roll-up word and NOTHING else.
 *
 * This is what an external poller (the OpenClaw alerting cron) reads to
 * decide whether to page someone. A bare status names no component, count,
 * commit, or cron — it leaks nothing an attacker can use — while every probe
 * name, detail and meta field stays authenticated-only. `ok` remains a
 * LIVENESS signal (the process answered), deliberately NOT tied to health:
 * the deploy script's liveness gate reads it, and a deploy must not be
 * blocked by the very degradation it is shipping the fix for.
 *
 * No `degradedSince` on purpose: deriving it would need persisted health
 * history, which does not exist and is not worth adding — the poller tracks
 * its own first-seen timestamp.
 */
export function publicHealthPayload(report: HealthReport): {
  ok: true;
  ts: number;
  status: ProbeStatus;
} {
  return { ok: true, ts: report.ts, status: report.status };
}

/** failed beats degraded beats unknown beats ok. */
export function rollUp(probes: Probe[]): ProbeStatus {
  if (probes.some((p) => p.status === "failed")) return "failed";
  if (probes.some((p) => p.status === "degraded")) return "degraded";
  if (probes.some((p) => p.status === "unknown")) return "unknown";
  return "ok";
}

export function runHealthChecks(now: number = Date.now()): HealthReport {
  const probes = [
    probeBuild(),
    probeDatabase(),
    probeClaudeCli(),
    probeExtractionConfig(),
    probeCrons(now),
    probeBackup(now),
  ];
  const status = rollUp(probes);
  return { ok: status === "ok" || status === "unknown", status, ts: now, probes };
}
