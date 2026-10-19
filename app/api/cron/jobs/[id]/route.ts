// Delete an OpenClaw cron job (2026-08-26, the operator's request — "clean up and
// delete old abandoned crons").
//
// POLICY NOTE: this is the one deliberate exception to the "GovScout
// observes the scheduler, never writes to it" rule (OPERATIONS.md
// § Scheduling, amended same day). Scope is exactly one verb — DELETE, of
// one job, by a logged-in human clicking a two-step confirm — executed
// through the openclaw CLI so the scheduler's own code owns the state
// change. GovScout still never creates, edits, or schedules jobs.
//
// execFile with an argv array, never a shell string — job ids are external
// input and the zsh-interpolation scar (GOVSCOUT_OPERATIONS §5) is standing.

import { execFile } from "child_process";
import { promisify } from "util";
import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { loadCronHealth } from "@/lib/cron-health";
import { tryLogActivity } from "@/lib/activity";

export const runtime = "nodejs";

const pExecFile = promisify(execFile);
// launchd starts the app with a minimal PATH; resolve the CLI absolutely.
const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? "/opt/homebrew/bin/openclaw";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  if (!UUID_RE.test(id)) return Response.json({ error: "invalid_id" }, { status: 400 });

  // Only delete a job the health view actually knows about — a typo'd or
  // stale id answers 404 instead of reaching the CLI at all.
  const job = loadCronHealth().find((c) => c.id === id);
  if (!job) return Response.json({ error: "not_found" }, { status: 404 });

  try {
    await pExecFile(OPENCLAW_BIN, ["cron", "rm", id, "--json"], { timeout: 30_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `openclaw cron rm failed: ${message}` }, { status: 502 });
  }

  // Verify the artifact, not the exit code: the job must be gone from the
  // scheduler state the health view reads.
  const still = loadCronHealth().find((c) => c.id === id);
  if (still) {
    return Response.json({ error: "delete_reported_ok_but_job_still_present" }, { status: 502 });
  }

  tryLogActivity({
    actor: session.email,
    actionType: "cron_deleted",
    targetType: "cron_job",
    targetId: id,
    summary: `Deleted cron "${job.name}" (was ${job.status}) via /cron-health`,
    detail: { jobId: id, jobName: job.name, statusAtDelete: job.status },
  });

  return Response.json({ deleted: true, id, name: job.name });
}
