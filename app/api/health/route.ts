import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { publicHealthPayload, runHealthChecks } from "@/lib/health";

export const runtime = "nodejs";

/**
 * Two audiences, deliberately different payloads.
 *
 * Unauthenticated (launchd, the tunnel, uptime checks, the deploy script's
 * liveness gate, and the OpenClaw alerting cron) gets {ok, ts, status} —
 * liveness plus the bare roll-up word, which is the minimum a poller needs to
 * decide whether to page someone. This endpoint is reachable at
 * https://app.govscout.ai/api/health, so the detailed report — commit hashes,
 * cron job names, table counts, backup directory names — must not be public.
 * That is inventory for an attacker, not a liveness signal. `ok` stays a
 * liveness constant; read `status` for health (see publicHealthPayload).
 *
 * Authenticated callers get the full probe set (V4.1 §14.2).
 */
export async function GET() {
  const session = await getSession();
  const report = runHealthChecks();
  if (!session) {
    return NextResponse.json(publicHealthPayload(report));
  }

  // 200 even when degraded: this is a report, and a non-200 would make the
  // liveness gate flap on a stale cron. Read `status`, not the HTTP code.
  return NextResponse.json(report);
}
