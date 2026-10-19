// Unified cron visibility (V4.1 §14.3).
//
// OpenClaw migrated its scheduler out of ~/.openclaw/cron/*.json into
// state/openclaw.sqlite. lib/cron-health.ts was still reading the abandoned
// JSON paths, so /cron-health showed nothing and the health probe reported
// "unknown" — while "Acme Consulting Grant Monitor - Weekly Pipeline" sat at 4
// consecutive errors, invisible.
//
// These cover the two pure pieces: is a job GovScout's business, and does a
// scheduler row map onto the health model correctly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  touchesGovScout,
  sqliteRowToCronHealth,
  resolveBlocked,
  classifyCronStatus,
  isGatewayRestartInterruption,
  type CronClassifyInput,
} from "../lib/cron-health";

// Regression: the first live run of the unified view reported "blocked" for
// two jobs that had succeeded that same morning with consecutive_errors=0,
// because the most recent *failure* in the run log still carried a rate-limit
// signal from days earlier. A stale block must not outrank a later success.
describe("stale upstream blocks", () => {
  const block = { reason: "rate limit", atMs: 1_000 };

  it("drops a block once something has succeeded after it", () => {
    assert.equal(resolveBlocked(block, 2_000), null);
  });

  it("keeps a block when the failure is the most recent event", () => {
    assert.deepEqual(resolveBlocked(block, 500), block);
  });

  it("keeps a block when nothing has ever succeeded", () => {
    assert.deepEqual(resolveBlocked(block, null), block);
  });

  it("drops a block when a success shares its timestamp", () => {
    assert.equal(resolveBlocked(block, 1_000), null);
  });

  it("passes through when there is no block", () => {
    assert.equal(resolveBlocked(null, 500), null);
  });
});

describe("GovScout relevance matcher", () => {
  it("matches the real jobs found in the live scheduler", () => {
    for (const name of [
      "Acme Consulting Grant Monitor - Weekly Pipeline",
      "SAM.gov Daily Micro-Contract Scanner",
      "Micro-sweep processor",
      "trackl-state-harvest-worker",
      "Gov Scout Daily Digest (v3 — Acme Consulting)",
      "Harbor County RFP Re-Procurement Watcher",
      "Behavioral Health Grant + STREETS NOFO Watcher",
      "govscout-demo-check",
    ]) {
      assert.equal(touchesGovScout(name), true, `should match: ${name}`);
    }
  });

  it("ignores jobs that have nothing to do with GovScout", () => {
    for (const name of [
      "DMARC/DKIM 3-week review",
      "Daily 6AM: System Update + Skill Digest",
      "Honcho memory trial — decision gate",
      "Concept Factory — 2 concepts/week",
    ]) {
      assert.equal(touchesGovScout(name), false, `should not match: ${name}`);
    }
  });

  it("matches specific signals in the payload and trigger script, not just the name", () => {
    assert.equal(touchesGovScout("nightly worker", "runs scripts/fp-amendment-watch.mts"), true);
    assert.equal(touchesGovScout("nightly worker", "cd projects/govscout-v5 && pnpm fp"), true);
    // Real body-only matches from the live scheduler: names reveal nothing,
    // prompts name GovScout's sources/artifacts.
    assert.equal(touchesGovScout("Acme Inbox Reply Watcher", "watch for replies about sam.gov listings"), true);
    assert.equal(touchesGovScout("pipeline-board-scout", "advance the track-l queue"), true);
    assert.equal(touchesGovScout("Weekly Brief (Monday Dashboard)", "summarise open RFP responses"), true);
  });

  // 2026-08-04: "Daily 6AM: System Update + Skill Discovery" — an OpenClaw
  // maintenance job — flipped the public /api/health status to "failed"
  // because its prompt's skill-search themes contained the words "contract"
  // and "procurement". A job's prompt says what it might MENTION; only its
  // name/description say what it IS. Generic English signals must not match
  // the prompt body.
  it("does not match generic English words in a prompt body", () => {
    assert.equal(
      touchesGovScout(
        "Daily 6AM: System Update + Skill Discovery",
        "Search skill themes: contract analysis, procurement automation, email drip sequencing.",
      ),
      false,
    );
    assert.equal(touchesGovScout("Concept Factory — 2 concepts/week", "brainstorm grant of options and award ceremonies"), false);
  });

  it("still matches generic words in the name or description (what the job IS)", () => {
    assert.equal(touchesGovScout("SAM.gov Weekly AI Contract Scanner"), true);
    assert.equal(touchesGovScout("Quarterly USDA Rural Development opportunity check"), true);
    assert.equal(touchesGovScout("Weekly review", "long prose"), false);
    assert.equal(touchesGovScout("Weekly procurement review", "long prose"), true);
  });

  // These two live jobs are genuinely GovScout pipeline work but carried only
  // generic body words before panel-sim/ungm were added as specific signals.
  it("keeps the panel-sim failsafe and UNGM follow-up jobs matched", () => {
    assert.equal(touchesGovScout("Overnight: panel-sim failsafe (run only if report missing)"), true);
    assert.equal(touchesGovScout("UNGM follow-up (1 week)"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(touchesGovScout("GOVSCOUT NIGHTLY"), true);
    assert.equal(touchesGovScout("TrAcK-L harvest"), true);
  });
});

// A gateway restart kills every job in flight and the scheduler records
// "error" for each — but that is an infrastructure event, not a job defect.
// The 6AM maintenance job even sequences its own self-update last so the
// interruption lands AFTER its report is delivered.
describe("gateway-restart interruptions", () => {
  it("recognises the scheduler's exact interruption text", () => {
    assert.equal(isGatewayRestartInterruption("cron: job interrupted by gateway restart"), true);
  });

  it("does not treat a genuine failure to restart a managed service as an interruption", () => {
    assert.equal(isGatewayRestartInterruption("failed to restart nginx: exit 1"), false);
    assert.equal(isGatewayRestartInterruption("error while restarting caddy"), false);
    assert.equal(isGatewayRestartInterruption(null), false);
    assert.equal(isGatewayRestartInterruption(undefined), false);
  });

  it("an interrupted last run does not classify as failed", () => {
    const { status, reason } = classifyCronStatus(
      {
        enabled: true,
        lastRunAtMs: 1_000_000,
        nextRunAtMs: 1_600_000,
        lastRunStatus: "error",
        consecutiveErrors: 0,
        blocked: null,
        lastRunInterrupted: true,
      },
      1_100_000,
    );
    assert.equal(status, "ok");
    assert.match(reason, /interrupted by a gateway restart/);
  });

  it("an interruption is transparent: it does not clear a real failure streak", () => {
    const { status, reason } = classifyCronStatus(
      {
        enabled: true,
        lastRunAtMs: 1_000_000,
        nextRunAtMs: 1_600_000,
        lastRunStatus: "error",
        consecutiveErrors: 3, // real errors older than the interruption
        blocked: null,
        lastRunInterrupted: true,
      },
      1_100_000,
    );
    assert.equal(status, "failed");
    assert.match(reason, /3 consecutive errors/);
  });

  it("maps the live 6AM row: interrupted last run over a success is ok", () => {
    // Run log (newest first): interrupted, ok, interrupted, ok — the exact
    // pattern that raised the false 'failed' on 2026-08-04.
    const h = sqliteRowToCronHealth(
      {
        ...baseRow,
        name: "Daily 6AM: System Update + Skill Discovery",
        last_run_status: "error",
        last_error: "cron: job interrupted by gateway restart",
        consecutive_errors: 1,
      },
      {
        lastSuccessMs: 1_000_000,
        lastFailureMs: null,
        blocked: null,
        effectiveConsecutiveErrors: 0,
        lastRunInterrupted: true,
      },
      1_100_000,
    );
    assert.equal(h.status, "ok");
    assert.equal(h.consecutiveErrors, 0);
  });

  it("falls back to the row's last_error when there is no run log", () => {
    const h = sqliteRowToCronHealth(
      {
        ...baseRow,
        last_run_status: "error",
        last_error: "cron: job interrupted by gateway restart",
        consecutive_errors: 1,
      },
      noSignals,
      1_100_000,
    );
    assert.equal(h.status, "ok");
    assert.equal(h.consecutiveErrors, 0, "the counted interruption is discounted");
  });

  it("a job that genuinely fails while restarting something still counts as failed", () => {
    const h = sqliteRowToCronHealth(
      {
        ...baseRow,
        last_run_status: "error",
        last_error: "failed to restart nginx: exit 1",
        consecutive_errors: 1,
      },
      noSignals,
      1_100_000,
    );
    assert.equal(h.status, "failed");
    assert.equal(h.consecutiveErrors, 1);
  });
});

const baseRow = {
  job_id: "job-1",
  name: "Acme Consulting Grant Monitor - Weekly Pipeline",
  display_name: null,
  description: null,
  enabled: 1,
  schedule_expr: "0 10 * * 1",
  schedule_kind: "cron",
  schedule_tz: "America/New_York",
  last_run_at_ms: 1_000_000,
  next_run_at_ms: 1_600_000,
  running_at_ms: null,
  last_run_status: "ok",
  last_error: null,
  last_duration_ms: 4200,
  consecutive_errors: 0,
  payload_message: null,
  trigger_script: null,
};
const noSignals = { lastSuccessMs: null, lastFailureMs: null, blocked: null };

describe("scheduler row -> health model", () => {
  it("maps a healthy job and marks it GovScout-relevant", () => {
    const h = sqliteRowToCronHealth(baseRow, noSignals, 1_100_000);
    assert.equal(h.status, "ok");
    assert.equal(h.govscoutRelevant, true);
    assert.equal(h.source, "sqlite");
    assert.equal(h.scheduleExpr, "0 10 * * 1");
    assert.equal(h.lastDurationMs, 4200);
  });

  it("surfaces the exact failure the audit found: 4 consecutive errors", () => {
    const h = sqliteRowToCronHealth(
      { ...baseRow, last_run_status: "error", consecutive_errors: 4, last_error: "upstream 500" },
      noSignals,
      1_100_000,
    );
    assert.equal(h.status, "failed");
    assert.equal(h.consecutiveErrors, 4);
    assert.equal(h.lastError, "upstream 500");
    assert.equal(h.govscoutRelevant, true, "this job must reach the GovScout dashboard");
  });

  it("reports a disabled job as disabled, not failed", () => {
    const h = sqliteRowToCronHealth({ ...baseRow, enabled: 0 }, noSignals, 1_100_000);
    assert.equal(h.status, "disabled");
  });

  it("distinguishes an upstream block from a crash", () => {
    const h = sqliteRowToCronHealth(
      { ...baseRow, last_run_status: "error", consecutive_errors: 1 },
      { lastSuccessMs: null, lastFailureMs: 900_000, blocked: { reason: "429", atMs: 900_000 } },
      1_100_000,
    );
    assert.equal(h.status, "blocked");
    assert.match(h.reason, /Upstream blocked/);
  });

  it("does not report blocked when the job has succeeded since the block", () => {
    // The live false alarm: rate-limited days ago, clean run this morning.
    const h = sqliteRowToCronHealth(
      { ...baseRow, last_run_status: "ok", consecutive_errors: 0 },
      { lastSuccessMs: 1_000_000, lastFailureMs: 400_000, blocked: { reason: "rate limit", atMs: 400_000 } },
      1_100_000,
    );
    assert.equal(h.status, "ok", "a recovered job must not stay blocked forever");
  });

  it("flags a job silent past 1.5x its interval as stale", () => {
    // interval 600_000; last run at 1_000_000; now well past 1.9M
    const h = sqliteRowToCronHealth(baseRow, noSignals, 2_000_000);
    assert.equal(h.status, "stale");
  });

  it("prefers display_name and truncates a long error", () => {
    const h = sqliteRowToCronHealth(
      { ...baseRow, display_name: "Weekly Pipeline", last_error: "x".repeat(500) },
      noSignals,
      1_100_000,
    );
    assert.equal(h.name, "Weekly Pipeline");
    assert.equal(h.lastError?.length, 300);
  });

  it("carries running_at_ms so an in-flight run is visible", () => {
    const h = sqliteRowToCronHealth({ ...baseRow, running_at_ms: 1_099_000 }, noSignals, 1_100_000);
    assert.equal(h.runningSinceMs, 1_099_000);
  });
});

// 2026-07-31: four GovScout discovery jobs were sitting disabled WITH failure
// streaks (up to 7 consecutive errors). A lane switched off mid-failure is a
// coverage gap, not a deliberate retirement — the classifier must not render
// the two identically.
describe("abandoned lanes", () => {
  const NOW = 1_100_000;
  const base = (over: Partial<CronClassifyInput> = {}): CronClassifyInput => ({
    enabled: true,
    lastRunAtMs: 1_000_000,
    nextRunAtMs: 1_600_000,
    lastRunStatus: "ok",
    consecutiveErrors: 0,
    blocked: null,
    ...over,
  });

  it("classifies disabled-with-errors as abandoned and names the error count", () => {
    const { status, reason } = classifyCronStatus(
      base({ enabled: false, lastRunStatus: "error", consecutiveErrors: 5 }),
      NOW,
    );
    assert.equal(status, "abandoned");
    assert.match(reason, /5 consecutive errors/);
    assert.match(reason, /[Dd]isabled/);
  });

  it("keeps disabled-with-zero-errors as plain disabled", () => {
    const { status, reason } = classifyCronStatus(base({ enabled: false }), NOW);
    assert.equal(status, "disabled");
    assert.equal(reason, "Job disabled — not scheduled.");
  });

  it("leaves an enabled failing job as failed, not abandoned", () => {
    const { status } = classifyCronStatus(
      base({ lastRunStatus: "error", consecutiveErrors: 3 }),
      NOW,
    );
    assert.equal(status, "failed");
  });

  it("returns abandoned before blocked is even considered", () => {
    const { status } = classifyCronStatus(
      base({
        enabled: false,
        lastRunStatus: "error",
        consecutiveErrors: 2,
        blocked: { reason: "429", atMs: 1_050_000 },
      }),
      NOW,
    );
    assert.equal(status, "abandoned");
  });

  it("flags the real Gov Scout Daily Digest row: disabled at 7 consecutive errors", () => {
    const h = sqliteRowToCronHealth(
      {
        ...baseRow,
        job_id: "govscout-daily-digest-v3",
        name: "Gov Scout Daily Digest (v3)",
        enabled: 0,
        last_run_status: "error",
        consecutive_errors: 7,
      },
      noSignals,
      NOW,
    );
    assert.equal(h.status, "abandoned");
    assert.match(h.reason, /7 consecutive errors/);
    assert.equal(h.govscoutRelevant, true, "an abandoned GovScout lane must reach the dashboard");
  });
});
