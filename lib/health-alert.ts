// Health-alert decision engine for the external watcher.
//
// The defect class this exists for: on 2026-07-27 GovScout served a broken
// bundle for four days because nothing outside the app was watching it. An
// external poller now reads the unauthenticated /api/health roll-up word and
// decides whether to page a human — and that decision (debounce thresholds,
// escalation, reminders, recovery) must be right, because it can wake someone
// at 3am or, worse, stay silent through an outage.
//
// So this module is PURE: no clock, no network, no filesystem. The runner
// (scripts/health-alert.mts) does the I/O and passes in an observation, the
// previous state, and `now`; everything decided here is unit-tested. State is
// a plain JSON-serialisable object the runner persists between polls.

import type { ProbeStatus } from "./health";

/** What one poll of /api/health observed. */
export type Observation =
  | { kind: "reached"; status: ProbeStatus } // the app answered with a status word
  | { kind: "unreachable"; reason: string }; // no response, timeout, non-200, bad JSON

/** The condition a watch episode is in: a probe status, or unreachable. */
export type Condition = ProbeStatus | "unreachable";

export type WatchState = {
  condition: Condition;
  /** Consecutive polls that observed this condition. */
  consecutive: number;
  /** When this condition was first observed (ms epoch). */
  firstSeenMs: number;
  /** When the last alert of this episode was sent; null when none was. */
  alertedAtMs: number | null;
  /**
   * The worst condition an alert has been sent for in this episode. Escalation
   * compares against this, not the previous poll — so failed -> degraded ->
   * failed (a flap) does not re-page: the human already knows about `failed`.
   */
  alertedCondition: Condition | null;
};

export type AlertKind = "onset" | "escalation" | "reminder" | "recovery";

export type AlertConfig = {
  /** Consecutive polls in a condition before the onset alert fires. */
  thresholds: Record<Exclude<Condition, "ok">, number>;
  /** How long after the last alert a still-bad condition re-alerts. */
  reminderMs: number;
};

// Defaults assume a 15-minute poll interval. `unknown` is deliberately the
// most patient: it means "unverifiable", which is usually a probe-environment
// problem, not an outage — but an indefinitely-unverifiable system is a real
// problem, so it still alerts eventually.
export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  thresholds: {
    unreachable: 2, // ~30 min — app down or tunnel down
    failed: 2, // ~30 min
    degraded: 4, // ~1 hour
    unknown: 8, // ~2 hours
  },
  reminderMs: 24 * 60 * 60 * 1000,
};

/** ok < unknown < degraded < failed < unreachable. */
const SEVERITY: Record<Condition, number> = {
  ok: 0,
  unknown: 1,
  degraded: 2,
  failed: 3,
  unreachable: 4,
};

const NEXT_STEP = "Check https://app.govscout.ai/cron-health or the authenticated /api/health.";

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h${min % 60 ? ` ${min % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Decide what one poll means: the next watch state, and the alert to send (if
 * any). Alert text stays terse — the condition word and duration only, no
 * probe detail; specifics live behind authentication.
 */
export function decideAlert(
  prev: WatchState | null,
  obs: Observation,
  nowMs: number,
  cfg?: Partial<AlertConfig>,
): { next: WatchState; alert: { kind: AlertKind; text: string } | null } {
  const config: AlertConfig = {
    ...DEFAULT_ALERT_CONFIG,
    ...cfg,
    thresholds: { ...DEFAULT_ALERT_CONFIG.thresholds, ...cfg?.thresholds },
  };
  const condition: Condition = obs.kind === "unreachable" ? "unreachable" : obs.status;
  const same = prev != null && prev.condition === condition;
  const next: WatchState = {
    condition,
    consecutive: same ? prev.consecutive + 1 : 1,
    firstSeenMs: same ? prev.firstSeenMs : nowMs,
    alertedAtMs: prev?.alertedAtMs ?? null,
    // Tolerate state written before alertedCondition existed.
    alertedCondition:
      prev?.alertedCondition ?? (prev != null && prev.alertedAtMs != null ? prev.condition : null),
  };

  if (condition === "ok") {
    const wasAlerted = next.alertedAtMs != null;
    next.alertedAtMs = null;
    next.alertedCondition = null;
    if (wasAlerted && prev != null) {
      // Alert exactly once per alerted episode. A blip that never crossed the
      // threshold has alertedAtMs null and produces total silence.
      const was =
        prev.condition !== "ok"
          ? ` (was ${prev.condition} for ${fmtDuration(nowMs - prev.firstSeenMs)})`
          : ""; // retry of an undelivered recovery alert
      return {
        next,
        alert: { kind: "recovery", text: `GovScout health: recovered to OK${was}.` },
      };
    }
    return { next, alert: null };
  }

  if (next.alertedAtMs != null) {
    const alertedFor = next.alertedCondition ?? condition;
    if (SEVERITY[condition] > SEVERITY[alertedFor]) {
      // Worse than anything already alerted: page immediately, no re-wait.
      next.alertedAtMs = nowMs;
      next.alertedCondition = condition;
      return {
        next,
        alert: {
          kind: "escalation",
          text: `GovScout health escalated: ${alertedFor} -> ${condition}. ${NEXT_STEP}`,
        },
      };
    }
    if (nowMs - next.alertedAtMs >= config.reminderMs) {
      // Still bad long after the last alert. A silent ongoing outage is
      // indistinguishable from a healthy system.
      const sinceAlert = nowMs - next.alertedAtMs;
      next.alertedAtMs = nowMs;
      next.alertedCondition = condition;
      return {
        next,
        alert: {
          kind: "reminder",
          text: `GovScout health: still ${condition} (${fmtDuration(sinceAlert)} since last alert). ${NEXT_STEP}`,
        },
      };
    }
    // Held, or improved-but-not-to-ok: silence. alertedAtMs is untouched so a
    // flapping system does not re-page on every dip.
    return { next, alert: null };
  }

  if (next.consecutive >= config.thresholds[condition]) {
    next.alertedAtMs = nowMs;
    next.alertedCondition = condition;
    return {
      next,
      alert: {
        kind: "onset",
        text: `GovScout health: ${condition} for ${fmtDuration(nowMs - next.firstSeenMs)}. ${NEXT_STEP}`,
      },
    };
  }
  return { next, alert: null };
}
