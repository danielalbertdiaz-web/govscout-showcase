// Sprint 7 — Auto-draft settings + queue management.
//
// GET   → current settings + recent log + open queue
// PATCH → update enabled and/or threshold
// POST  → release a queued auto-draft (body: { queueId })

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getAutoDraftEnabled,
  getAutoDraftThreshold,
  listAutoDraftLog,
  listAutoDraftQueue,
  releaseQueuedAutoDraft,
  setSetting,
  AUTO_DRAFT_THRESHOLD_DEFAULT,
  AUTO_DRAFT_RATE_LIMIT_24H,
} from "@/lib/auto-draft";
import { emitMutation } from "@/lib/events";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({
    enabled: getAutoDraftEnabled(),
    envForcesDisabled:
      ["false", "0", "off"].includes((process.env.AUTO_DRAFT_ENABLED ?? "").trim().toLowerCase()),
    threshold: getAutoDraftThreshold(),
    thresholdDefault: AUTO_DRAFT_THRESHOLD_DEFAULT,
    rateLimit24h: AUTO_DRAFT_RATE_LIMIT_24H,
    log: listAutoDraftLog({ userEmail: session.email, limit: 50 }),
    queue: listAutoDraftQueue({ userEmail: session.email, openOnly: true }),
  });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: unknown;
    threshold?: unknown;
  };

  if (body.enabled !== undefined) {
    const flag = Boolean(body.enabled);
    setSetting("auto_draft:enabled", flag);
  }
  if (body.threshold !== undefined) {
    const n = Number(body.threshold);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return Response.json({ error: "threshold_out_of_range" }, { status: 400 });
    }
    setSetting("auto_draft:threshold", n);
  }
  return Response.json({
    enabled: getAutoDraftEnabled(),
    threshold: getAutoDraftThreshold(),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { queueId?: string };
  if (!body.queueId) return Response.json({ error: "queueId_required" }, { status: 400 });
  const result = await releaseQueuedAutoDraft(String(body.queueId), session.email);
  if (result.outcome === "created" && result.draftId) {
    emitMutation({
      type: "draft_status_changed",
      userEmail: session.email,
      at: Date.now(),
      draftId: result.draftId,
      autoDrafted: true,
      releasedFromQueue: true,
    });
  }
  return Response.json(result);
}
