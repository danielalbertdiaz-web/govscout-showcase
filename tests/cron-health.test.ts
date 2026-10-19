// Unit tests for the cron-health classifier (Item 1.3).
//
// classifyCronStatus is a pure function: given a snapshot of a cron's run state
// plus an injectable `now`, it returns one of ok/stale/failed/blocked/disabled.
// These fixtures pin the priority order (disabled > blocked > failed > stale > ok)
// and the staleness threshold (silent past 1.5x the expected interval), with no
// filesystem access.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyCronStatus, type CronClassifyInput } from "../lib/cron-health";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 5, 5, 12, 0, 0); // 2026-06-05T12:00:00Z

// A healthy hourly cron: ran 10m ago, due in 50m, last status ok, no errors.
function healthy(): CronClassifyInput {
  return {
    enabled: true,
    lastRunAtMs: NOW - 10 * 60_000,
    nextRunAtMs: NOW + 50 * 60_000,
    lastRunStatus: "ok",
    consecutiveErrors: 0,
    blocked: null,
  };
}

test("ok: recent successful run within interval", () => {
  const { status } = classifyCronStatus(healthy(), NOW);
  assert.equal(status, "ok");
});

test("disabled-with-errors is abandoned, not merely disabled", () => {
  const i: CronClassifyInput = {
    ...healthy(),
    enabled: false,
    lastRunStatus: "error",
    consecutiveErrors: 5,
    blocked: { reason: "429", atMs: NOW },
  };
  const { status, reason } = classifyCronStatus(i, NOW);
  assert.equal(status, "abandoned");
  assert.match(reason, /disabled/i);
  assert.match(reason, /5 consecutive errors/);
});

// Pins the surviving half of the original "disabled wins over everything" assertion.
test("a cleanly disabled job still outranks a blocked signal", () => {
  const i: CronClassifyInput = {
    ...healthy(),
    enabled: false,
    lastRunStatus: "error",
    consecutiveErrors: 0,
    blocked: { reason: "429", atMs: NOW },
  };
  const { status, reason } = classifyCronStatus(i, NOW);
  assert.equal(status, "disabled");
  assert.equal(reason, "Job disabled — not scheduled.");
});

test("blocked wins over failed/stale (upstream refusal, not a crash)", () => {
  const i: CronClassifyInput = {
    ...healthy(),
    lastRunStatus: "error",
    consecutiveErrors: 3,
    blocked: { reason: "rate-limited", atMs: NOW },
  };
  const { status, reason } = classifyCronStatus(i, NOW);
  assert.equal(status, "blocked");
  assert.match(reason, /rate-limited/);
});

test("failed: last run status is not ok", () => {
  const i: CronClassifyInput = { ...healthy(), lastRunStatus: "error" };
  const { status, reason } = classifyCronStatus(i, NOW);
  assert.equal(status, "failed");
  assert.match(reason, /last run "error"/);
});

test("failed: consecutive errors even when last status reads ok", () => {
  const i: CronClassifyInput = { ...healthy(), lastRunStatus: "ok", consecutiveErrors: 2 };
  const { status, reason } = classifyCronStatus(i, NOW);
  assert.equal(status, "failed");
  assert.match(reason, /2 consecutive errors/);
});

test("stale: silent past 1.5x the expected interval", () => {
  // Expected interval = next - last = 1h. Last run 2h ago => 2x interval > 1.5x.
  const i: CronClassifyInput = {
    enabled: true,
    lastRunAtMs: NOW - 2 * HOUR,
    nextRunAtMs: NOW - 1 * HOUR, // was due an hour ago
    lastRunStatus: "ok",
    consecutiveErrors: 0,
    blocked: null,
  };
  const { status, reason } = classifyCronStatus(i, NOW);
  assert.equal(status, "stale");
  assert.match(reason, /overdue/i);
});

test("not stale at exactly 1.5x (boundary stays ok)", () => {
  // interval 1h, last run 1.5h ago => now - last == 1.5x, threshold is strictly >.
  const i: CronClassifyInput = {
    enabled: true,
    lastRunAtMs: NOW - 1.5 * HOUR,
    nextRunAtMs: NOW - 0.5 * HOUR,
    lastRunStatus: "ok",
    consecutiveErrors: 0,
    blocked: null,
  };
  const { status } = classifyCronStatus(i, NOW);
  assert.equal(status, "ok");
});

test("ok when interval data is missing (no false staleness)", () => {
  const i: CronClassifyInput = {
    enabled: true,
    lastRunAtMs: null,
    nextRunAtMs: null,
    lastRunStatus: "ok",
    consecutiveErrors: 0,
    blocked: null,
  };
  const { status } = classifyCronStatus(i, NOW);
  assert.equal(status, "ok");
});

test("lastRunStatus is case-insensitive (OK == ok)", () => {
  const i: CronClassifyInput = { ...healthy(), lastRunStatus: "OK" };
  assert.equal(classifyCronStatus(i, NOW).status, "ok");
});
