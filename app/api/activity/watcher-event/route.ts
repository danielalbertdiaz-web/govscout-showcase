import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  ingestWatcherEvent,
  isExtendedEventType,
  isSeverity,
  isWatcherSource,
  type ExtendedEventType,
  type Severity,
  type WatcherSource,
} from "@/lib/activity";

export const runtime = "nodejs";

// POST /api/activity/watcher-event — dual-write target for daily watcher crons.
// Auth: a valid session OR an `x-watcher-secret` header matching
// process.env.WATCHER_INGEST_SECRET. Cron jobs use the shared secret since they
// don't carry a session cookie.
export async function POST(req: NextRequest) {
  const sharedSecret = process.env.WATCHER_INGEST_SECRET ?? "";
  const header = req.headers.get("x-watcher-secret") ?? "";
  const authedBySecret = sharedSecret.length > 0 && header === sharedSecret;

  if (!authedBySecret) {
    const session = await getSession();
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const source = typeof body.source === "string" ? body.source : "";
  const severity = typeof body.severity === "string" ? body.severity : "";
  const eventType = typeof body.eventType === "string" ? body.eventType : "";
  const summary = typeof body.summary === "string" ? body.summary.trim() : "";

  if (!isWatcherSource(source)) {
    return Response.json({ error: "invalid_source", got: source }, { status: 400 });
  }
  if (!isSeverity(severity)) {
    return Response.json({ error: "invalid_severity", got: severity }, { status: 400 });
  }
  if (!isExtendedEventType(eventType)) {
    return Response.json({ error: "invalid_eventType", got: eventType }, { status: 400 });
  }
  if (!summary) {
    return Response.json({ error: "summary_required" }, { status: 400 });
  }

  const newItemsCount =
    typeof body.newItemsCount === "number" && Number.isFinite(body.newItemsCount)
      ? Math.trunc(body.newItemsCount)
      : null;
  const errorsCount =
    typeof body.errorsCount === "number" && Number.isFinite(body.errorsCount)
      ? Math.trunc(body.errorsCount)
      : null;
  const needsReview = Boolean(body.needsReview);
  const detail =
    body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
      ? (body.detail as Record<string, unknown>)
      : null;

  const entry = ingestWatcherEvent({
    source: source as WatcherSource,
    severity: severity as Severity,
    eventType: eventType as ExtendedEventType,
    summary,
    newItemsCount,
    errorsCount,
    needsReview,
    detail,
  });

  return Response.json({ ok: true, id: entry.id });
}
