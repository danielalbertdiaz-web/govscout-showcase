/**
 * External health watcher (thin runner; runs under launchd every 15 minutes).
 *
 * Run: node --import tsx scripts/health-alert.mts
 * Env: GOVSCOUT_HEALTH_STATE   — watch-state JSON path
 *                                (default ~/.openclaw/state/govscout-health-watch.json)
 *      GOVSCOUT_ALERT_DRY_RUN  — "1" prints alerts instead of sending Telegram
 *
 * All decision logic lives in lib/health-alert.ts (pure, tested). This file
 * only: polls the LOCAL /api/health (the public URL would conflate app health
 * with tunnel health), loads/stores state, and sends the Telegram message.
 *
 * Exit code is 0 even when an outage is detected — detecting an outage is
 * SUCCESS for this script, and a nonzero exit under launchd would be
 * confusing and could trigger retry behaviour.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import {
  decideAlert,
  type Observation,
  type WatchState,
} from "../lib/health-alert";
import type { ProbeStatus } from "../lib/health";

const HEALTH_URL = "http://127.0.0.1:3000/api/health";
const FETCH_TIMEOUT_MS = 5_000;
const STATE_PATH =
  process.env.GOVSCOUT_HEALTH_STATE ??
  path.join(os.homedir(), ".openclaw", "state", "govscout-health-watch.json");
const OPENCLAW_BIN = "/opt/homebrew/bin/openclaw";
const TELEGRAM_TARGET = "0000000000";

const VALID_STATUSES = new Set<string>(["ok", "degraded", "failed", "unknown"]);

async function observe(): Promise<Observation> {
  let res: Response;
  try {
    res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { kind: "unreachable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { kind: "unreachable", reason: `HTTP ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unreachable", reason: "unparseable JSON" };
  }
  const status = (body as { status?: unknown } | null)?.status;
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    // An old build that predates the status field must not read as healthy.
    return {
      kind: "unreachable",
      reason: `health payload has no valid status field (got ${JSON.stringify(status)})`,
    };
  }
  return { kind: "reached", status: status as ProbeStatus };
}

// Missing or corrupt state must never wedge the watcher: start fresh, say so.
function loadState(): WatchState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_PATH, "utf8");
  } catch {
    console.error(`health-alert: no state file at ${STATE_PATH} — starting fresh`);
    return null;
  }
  try {
    const s = JSON.parse(raw) as WatchState;
    if (
      typeof s?.condition === "string" &&
      typeof s?.consecutive === "number" &&
      typeof s?.firstSeenMs === "number"
    ) {
      return s;
    }
    console.error(`health-alert: state file ${STATE_PATH} has unexpected shape — starting fresh`);
    return null;
  } catch (err) {
    console.error(
      `health-alert: state file ${STATE_PATH} is corrupt (${err instanceof Error ? err.message : String(err)}) — starting fresh`,
    );
    return null;
  }
}

// Atomic write (temp file + rename): a torn write must not wedge the watcher.
function saveState(state: WatchState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_PATH);
}

function sendAlert(text: string): boolean {
  if (process.env.GOVSCOUT_ALERT_DRY_RUN === "1") {
    console.log(`health-alert: DRY RUN — would send: ${text}`);
    return true;
  }
  try {
    execFileSync(
      OPENCLAW_BIN,
      ["message", "send", "--channel", "telegram", "--target", TELEGRAM_TARGET, "-m", text],
      { stdio: ["ignore", "inherit", "inherit"], timeout: 30_000 },
    );
    return true;
  } catch (err) {
    console.error(
      `health-alert: telegram send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

const prev = loadState();
const obs = await observe();
const { next, alert } = decideAlert(prev, obs, Date.now());

let toPersist = next;
if (alert) {
  const sent = sendAlert(alert.text);
  if (!sent) {
    // Do NOT record an undelivered alert as sent — the next poll must retry
    // it. The rest of the state persists so the counters stay accurate.
    toPersist = {
      ...next,
      alertedAtMs: prev?.alertedAtMs ?? null,
      alertedCondition: prev?.alertedCondition ?? null,
    };
  }
  console.log(`health-alert: ${alert.kind}${sent ? "" : " (send failed — will retry)"}: ${alert.text}`);
} else {
  console.log(`health-alert: ${next.condition} x${next.consecutive} — no alert`);
}
saveState(toPersist);
