// Unit tests for the health-alert decision engine (external watcher).
//
// decideAlert is pure: previous state + one observation + `now` in, next state
// + at-most-one alert out. These fixtures pin the debounce thresholds, the
// once-per-episode onset, immediate escalation, silence on partial
// improvement, 24h reminders, and recovery-only-after-a-real-alert — the
// exact behaviours that decide whether a human gets paged at 3am.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideAlert,
  DEFAULT_ALERT_CONFIG,
  type AlertKind,
  type Observation,
  type WatchState,
} from "../lib/health-alert";

const POLL = 15 * 60_000; // 15-minute poll interval
const T0 = Date.UTC(2026, 7, 4, 0, 0, 0); // 2026-08-04T00:00:00Z

const reached = (status: "ok" | "degraded" | "failed" | "unknown"): Observation => ({
  kind: "reached",
  status,
});
const unreachable: Observation = { kind: "unreachable", reason: "timeout" };

/** Run a sequence of observations at 15-minute intervals; collect the alerts. */
function run(
  obs: Observation[],
  startState: WatchState | null = null,
  startMs: number = T0,
): { state: WatchState | null; alerts: Array<{ kind: AlertKind; at: number }> } {
  let state = startState;
  const alerts: Array<{ kind: AlertKind; at: number }> = [];
  obs.forEach((o, idx) => {
    const now = startMs + idx * POLL;
    const { next, alert } = decideAlert(state, o, now);
    if (alert) alerts.push({ kind: alert.kind, at: idx });
    state = next;
  });
  return { state, alerts };
}

describe("onset thresholds", () => {
  it("failed: silent at n-1, alerts at n=2", () => {
    const { alerts } = run([reached("failed"), reached("failed")]);
    assert.deepEqual(alerts, [{ kind: "onset", at: 1 }]);
  });

  it("unreachable: alerts on the second consecutive unreachable poll (~30 min)", () => {
    const { alerts } = run([unreachable, unreachable]);
    assert.deepEqual(alerts, [{ kind: "onset", at: 1 }]);
  });

  it("degraded: silent through 3 polls, alerts on the 4th (~1 hour)", () => {
    const { alerts } = run(Array(4).fill(reached("degraded")));
    assert.deepEqual(alerts, [{ kind: "onset", at: 3 }]);
  });

  it("unknown is the most patient: silent through 7 polls, alerts on the 8th", () => {
    const seven = run(Array(7).fill(reached("unknown")));
    assert.deepEqual(seven.alerts, []);
    const eight = run(Array(8).fill(reached("unknown")));
    assert.deepEqual(eight.alerts, [{ kind: "onset", at: 7 }]);
  });

  it("thresholds are overridable via config", () => {
    const { alert } = decideAlert(null, reached("failed"), T0, { thresholds: { ...DEFAULT_ALERT_CONFIG.thresholds, failed: 1 } });
    assert.equal(alert?.kind, "onset");
  });

  it("does not re-alert while the condition holds", () => {
    const { alerts } = run(Array(10).fill(reached("failed")));
    assert.deepEqual(alerts, [{ kind: "onset", at: 1 }]);
  });

  it("the counter resets on any condition change", () => {
    // 3 degraded polls (sub-threshold), then failed: failed starts at 1 and
    // must wait for its own threshold — escalation is only for already-alerted
    // episodes.
    const { alerts, state } = run([
      reached("degraded"),
      reached("degraded"),
      reached("degraded"),
      reached("failed"),
    ]);
    assert.deepEqual(alerts, []);
    assert.equal(state?.consecutive, 1);
    assert.equal(state?.condition, "failed");
  });
});

describe("escalation", () => {
  it("fires immediately when an alerted condition worsens (degraded -> failed)", () => {
    const { alerts } = run([...Array(4).fill(reached("degraded")), reached("failed")]);
    assert.deepEqual(alerts, [
      { kind: "onset", at: 3 },
      { kind: "escalation", at: 4 },
    ]);
  });

  it("fires immediately on anything -> unreachable while alerted", () => {
    const { alerts } = run([reached("failed"), reached("failed"), unreachable]);
    assert.deepEqual(alerts, [
      { kind: "onset", at: 1 },
      { kind: "escalation", at: 2 },
    ]);
  });

  it("partial improvement (failed -> degraded) stays silent and keeps alertedAtMs", () => {
    const two = run([reached("failed"), reached("failed")]);
    const alertedAt = two.state?.alertedAtMs;
    assert.ok(alertedAt != null);
    const { state, alerts } = run([reached("degraded")], two.state, T0 + 2 * POLL);
    assert.deepEqual(alerts, []);
    assert.equal(state?.alertedAtMs, alertedAt, "a dip must not reset the alert clock");
  });

  it("a flap back to the already-alerted severity does not re-page", () => {
    // failed (alerted) -> degraded -> failed: the human already knows about
    // failed; re-paging on every rise of a flapping system is noise.
    const { alerts } = run([
      reached("failed"),
      reached("failed"),
      reached("degraded"),
      reached("failed"),
      reached("degraded"),
      reached("failed"),
    ]);
    assert.deepEqual(alerts, [{ kind: "onset", at: 1 }]);
  });

  it("but worsening beyond the alerted severity still escalates after a flap", () => {
    const { alerts } = run([
      reached("failed"),
      reached("failed"),
      reached("degraded"),
      unreachable,
    ]);
    assert.deepEqual(alerts, [
      { kind: "onset", at: 1 },
      { kind: "escalation", at: 3 },
    ]);
  });
});

describe("recovery", () => {
  it("alerts exactly once when returning to ok after a real alert", () => {
    const { alerts } = run([
      reached("failed"),
      reached("failed"),
      reached("ok"),
      reached("ok"),
    ]);
    assert.deepEqual(alerts, [
      { kind: "onset", at: 1 },
      { kind: "recovery", at: 2 },
    ]);
  });

  it("a sub-threshold blip is silent in both directions", () => {
    const { alerts } = run([
      reached("ok"),
      reached("degraded"),
      reached("degraded"),
      reached("ok"),
      reached("ok"),
    ]);
    assert.deepEqual(alerts, []);
  });

  it("recovery clears the episode: a new outage needs a fresh threshold", () => {
    const { alerts } = run([
      reached("failed"),
      reached("failed"),
      reached("ok"),
      reached("failed"),
      reached("failed"),
    ]);
    assert.deepEqual(alerts, [
      { kind: "onset", at: 1 },
      { kind: "recovery", at: 2 },
      { kind: "onset", at: 4 },
    ]);
  });
});

describe("reminder", () => {
  it("re-alerts when the condition is still bad 24h after the last alert", () => {
    // Onset at poll 2, then hold failed for a full day of 15-minute polls.
    const dayOfPolls = Math.ceil((24 * 60) / 15) + 2;
    const { alerts } = run(Array(dayOfPolls + 2).fill(reached("failed")));
    assert.equal(alerts[0].kind, "onset");
    assert.equal(alerts.length, 2, "exactly one reminder in ~24h");
    assert.equal(alerts[1].kind, "reminder");
    const gapMs = (alerts[1].at - alerts[0].at) * POLL;
    assert.ok(gapMs >= 24 * 3_600_000, `reminder fired only ${gapMs}ms after onset`);
  });

  it("stays silent short of the reminder window", () => {
    const prev: WatchState = {
      condition: "failed",
      consecutive: 10,
      firstSeenMs: T0,
      alertedAtMs: T0,
      alertedCondition: "failed",
    };
    const { alert } = decideAlert(prev, reached("failed"), T0 + 23 * 3_600_000);
    assert.equal(alert, null);
  });

  it("reminder window is overridable via config", () => {
    const prev: WatchState = {
      condition: "failed",
      consecutive: 10,
      firstSeenMs: T0,
      alertedAtMs: T0,
      alertedCondition: "failed",
    };
    const { alert } = decideAlert(prev, reached("failed"), T0 + 3_600_000, { reminderMs: 3_600_000 });
    assert.equal(alert?.kind, "reminder");
  });
});

describe("alert text", () => {
  it("leads with the condition, includes duration, and points at the next step", () => {
    const one = decideAlert(null, reached("failed"), T0);
    const two = decideAlert(one.next, reached("failed"), T0 + POLL);
    assert.match(two.alert!.text, /^GovScout health: failed for 15m\./);
    assert.match(two.alert!.text, /app\.govscout\.ai\/cron-health/);
  });

  it("never leaks probe detail — the unreachable reason stays out of the message", () => {
    const one = decideAlert(null, { kind: "unreachable", reason: "ECONNREFUSED 127.0.0.1:3000" }, T0);
    const two = decideAlert(one.next, { kind: "unreachable", reason: "ECONNREFUSED 127.0.0.1:3000" }, T0 + POLL);
    assert.equal(two.alert?.kind, "onset");
    assert.doesNotMatch(two.alert!.text, /ECONNREFUSED|127\.0\.0\.1|3000/);
  });
});

describe("state plumbing", () => {
  it("state survives a JSON round-trip", () => {
    const { state } = run([reached("degraded"), reached("degraded")]);
    const revived = JSON.parse(JSON.stringify(state)) as WatchState;
    const { next } = decideAlert(revived, reached("degraded"), T0 + 2 * POLL);
    assert.equal(next.consecutive, 3);
    assert.equal(next.firstSeenMs, T0);
  });

  it("tolerates state written before alertedCondition existed", () => {
    const legacy = {
      condition: "degraded",
      consecutive: 4,
      firstSeenMs: T0,
      alertedAtMs: T0 + 3 * POLL,
    } as WatchState;
    const { next, alert } = decideAlert(legacy, reached("failed"), T0 + 4 * POLL);
    assert.equal(alert?.kind, "escalation", "alerted-for condition inferred from prev.condition");
    assert.equal(next.alertedCondition, "failed");
  });

  it("an undelivered recovery alert can be retried from persisted state", () => {
    // The runner keeps alertedAtMs when the send fails; the next ok poll must
    // produce the recovery alert again even though prev.condition is already ok.
    const afterFailedSend: WatchState = {
      condition: "ok",
      consecutive: 1,
      firstSeenMs: T0,
      alertedAtMs: T0 - POLL,
      alertedCondition: "failed",
    };
    const { next, alert } = decideAlert(afterFailedSend, reached("ok"), T0 + POLL);
    assert.equal(alert?.kind, "recovery");
    assert.equal(next.alertedAtMs, null);
  });
});

// The end-to-end shape of a real bad day: a degraded hour, collapse to
// failed, a long failed stretch, then recovery — as one continuous run of
// 15-minute polls, asserting the exact alert sequence.
describe("full-day episode", () => {
  it("degraded -> failed -> ok produces onset, escalation, recovery — nothing else", () => {
    const obs: Observation[] = [
      ...Array(8).fill(reached("ok")), // quiet morning
      ...Array(4).fill(reached("degraded")), // degradation begins
      ...Array(6).fill(reached("failed")), // collapses
      ...Array(2).fill(reached("degraded")), // partial improvement
      ...Array(8).fill(reached("ok")), // recovered
    ];
    const { alerts, state } = run(obs);
    assert.deepEqual(alerts, [
      { kind: "onset", at: 11 }, // 4th degraded poll
      { kind: "escalation", at: 12 }, // first failed poll, immediately
      { kind: "recovery", at: 20 }, // first ok poll
    ]);
    assert.equal(state?.condition, "ok");
    assert.equal(state?.alertedAtMs, null, "the episode is fully closed");
  });
});
