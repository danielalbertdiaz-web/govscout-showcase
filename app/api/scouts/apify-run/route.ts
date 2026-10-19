// Sprint 8 — Apify watcher trigger.
//
// POST /api/scouts/apify-run
//   body: { family?: "foundation" | "lead_portal" | "all" }
//   default: "all" — runs both families sequentially.
//
// Returns per-family results + aggregate counts. Token check happens
// inside lib/apify.ts; this route just orchestrates and surfaces the
// outcome shape the Scouts pane needs to render a summary toast.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getApifyToken } from "@/lib/apify";
import { runWatcher, type WatcherRunResult } from "@/lib/sources/apify-watcher";
import { emitMutation } from "@/lib/events";

export const runtime = "nodejs";
// Sync Apify runs cap at ~5 min; bump Next handler to match.
export const maxDuration = 300;

type Body = {
  family?: "foundation" | "lead_portal" | "all";
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  if (!getApifyToken()) {
    return Response.json(
      {
        error: "apify_token_missing",
        instruction:
          "Set APIFY_TOKEN in projects/govscout-v5/.env.local (or .env). The Apify free tier provides ~$5/mo credit; this run is capped at $1.25.",
      },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const choice = body.family ?? "all";
  const families: Array<"foundation" | "lead_portal"> =
    choice === "all" ? ["foundation", "lead_portal"] : [choice];

  const results: WatcherRunResult[] = [];
  for (const family of families) {
    const r = await runWatcher({
      userEmail: session.email,
      family,
      signal: req.signal,
    }).catch((err) => ({
      family,
      ok: false,
      digestId: null,
      newItems: 0,
      skippedDedup: 0,
      blockedTargets: [] as string[],
      costUsd: 0,
      durationMs: 0,
      apifyStatus: "failed" as const,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WatcherRunResult));
    results.push(r);
  }

  const totals = {
    newItems: results.reduce((s, r) => s + r.newItems, 0),
    skippedDedup: results.reduce((s, r) => s + r.skippedDedup, 0),
    blockedTargetCount: results.reduce((s, r) => s + r.blockedTargets.length, 0),
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
  };

  // Notify other panes that scout data shifted.
  if (totals.newItems > 0) {
    emitMutation({
      type: "activity",
      userEmail: session.email,
      at: Date.now(),
      apifyRun: true,
      ...totals,
    });
  }

  return Response.json({ results, totals });
}
