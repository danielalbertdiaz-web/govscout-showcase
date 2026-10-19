// Health probe logic (V4.1 §14.2).
//
// The build-drift comparison is the whole point of this module — it is what
// would have caught the 2026-07-27 stale build within one health check instead
// of four days. It is pure, so it is tested directly rather than through the
// route.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareBuildToSource,
  publicHealthPayload,
  rollUp,
  type BuildMeta,
  type HealthReport,
  type Probe,
  type ProbeStatus,
} from "../lib/health";

const meta: BuildMeta = {
  commit: "e0de41b4d9541f1749442fc540f199403283464c",
  buildId: "ZPYwPMGkNNnXS7m844xKc",
  builtAt: "2026-07-27T04:41:13Z",
};

describe("build drift detection", () => {
  it("is ok when the running build matches the checked-out commit", () => {
    const p = compareBuildToSource(meta, meta.commit, meta.buildId);
    assert.equal(p.status, "ok");
  });

  it("flags the 2026-07-27 failure: source moved past the deployed build", () => {
    const p = compareBuildToSource(meta, "5635624aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", meta.buildId);
    assert.equal(p.status, "degraded");
    assert.match(p.detail, /Source has moved/);
    assert.match(p.detail, /deploy\.sh/);
  });

  it("fails hard when a build completed but the process was never restarted", () => {
    // build-meta.json records the new build; the running process still serves the old bundle.
    const p = compareBuildToSource(meta, meta.commit, "someOtherRunningBuildId");
    assert.equal(p.status, "failed");
    assert.match(p.detail, /without a restart/);
  });

  it("reports unknown rather than ok when build-meta.json is absent", () => {
    const p = compareBuildToSource(null, meta.commit, meta.buildId);
    assert.equal(p.status, "unknown");
    assert.notEqual(p.status, "ok", "a build we cannot verify must never read as healthy");
  });

  it("reports unknown rather than ok when HEAD cannot be read", () => {
    const p = compareBuildToSource(meta, null, meta.buildId);
    assert.equal(p.status, "unknown");
  });

  it("prefers the restart failure over the drift warning when both apply", () => {
    const p = compareBuildToSource(meta, "differentcommit0000000000000000000000000", "differentBuildId");
    assert.equal(p.status, "failed", "an unrestarted process is more urgent than moved source");
  });
});

describe("status roll-up", () => {
  const probe = (status: Probe["status"]): Probe => ({ name: "x", status, detail: "" });

  it("failed dominates everything", () => {
    assert.equal(rollUp([probe("ok"), probe("degraded"), probe("unknown"), probe("failed")]), "failed");
  });

  it("degraded beats unknown and ok", () => {
    assert.equal(rollUp([probe("ok"), probe("unknown"), probe("degraded")]), "degraded");
  });

  it("unknown beats ok — an unverifiable system is not a healthy one", () => {
    assert.equal(rollUp([probe("ok"), probe("unknown")]), "unknown");
  });

  it("all ok rolls up to ok", () => {
    assert.equal(rollUp([probe("ok"), probe("ok")]), "ok");
  });

  it("an empty probe set is ok", () => {
    assert.equal(rollUp([]), "ok");
  });
});

// The UNAUTHENTICATED payload (alerting packet). The endpoint is public at
// app.govscout.ai, so the poller-facing shape is the roll-up word and nothing
// else — probe names, details and meta are inventory for an attacker and stay
// authenticated-only. The route serves publicHealthPayload(report) to
// unauthenticated callers and the report verbatim to authenticated ones; the
// payload builder is pure, so it is tested directly (same pattern as the rest
// of this file — getSession cannot run outside a request scope).
describe("unauthenticated health payload", () => {
  const ROLL_UP_VALUES: readonly ProbeStatus[] = ["ok", "degraded", "failed", "unknown"];

  const failingProbe: Probe = {
    name: "crons",
    status: "failed",
    detail: "3 GovScout job(s) failing: Gov Scout Daily Digest (7 consecutive).",
    meta: { failed: ["digest-job-id"] },
  };
  const report = (status: ProbeStatus, probes: Probe[]): HealthReport => ({
    ok: status === "ok" || status === "unknown",
    status,
    ts: 1_754_500_000_000,
    probes,
  });

  it("contains exactly ok, ts, status — a future field cannot leak in unnoticed", () => {
    const payload = publicHealthPayload(report("degraded", [failingProbe]));
    assert.deepEqual(Object.keys(payload).sort(), ["ok", "status", "ts"]);
  });

  it("carries no probes array, no meta, and no probe text at all", () => {
    const payload = publicHealthPayload(report("failed", [failingProbe]));
    assert.ok(!("probes" in payload));
    assert.ok(!("meta" in payload));
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("crons"), "probe names must not leak");
    assert.ok(!serialized.includes("Daily Digest"), "probe detail must not leak");
    assert.ok(!serialized.includes("digest-job-id"), "probe meta must not leak");
  });

  it("status is constrained to the four roll-up values", () => {
    for (const status of ROLL_UP_VALUES) {
      const payload = publicHealthPayload(report(status, []));
      assert.equal(payload.status, status);
      assert.ok(ROLL_UP_VALUES.includes(payload.status));
    }
  });

  it("a failed probe surfaces as status 'failed' while the reason stays authenticated-only", () => {
    const full = report("failed", [failingProbe]);
    const payload = publicHealthPayload(full);
    assert.equal(payload.status, "failed");
    assert.ok(!JSON.stringify(payload).includes("consecutive"), "the WHY is authenticated-only");
    // the authenticated report — served verbatim by the route — still has it,
    // and building the public payload did not mutate it
    assert.equal(full.probes[0].detail.includes("7 consecutive"), true);
    assert.equal(full.probes.length, 1);
  });

  it("ok stays a liveness constant, not a health verdict", () => {
    // The deploy script's liveness gate reads `ok`; a deploy must not be
    // blocked by the very degradation it is shipping the fix for.
    assert.equal(publicHealthPayload(report("failed", [failingProbe])).ok, true);
  });
});
