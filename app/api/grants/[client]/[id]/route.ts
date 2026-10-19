// Grants Workspace API — status transitions for one client panel's rows
// ONLY. Reuses the same setFpStatus plumbing as `fp set-status` (one
// transaction, trail event at the write), but hard-scopes every lookup to
// the client named in the route: another panel's row id answers 404, never
// a transition (PANEL_ISOLATION_SPEC.md — the route never sees unscoped
// rows to filter after the fact). Serves /grants/riverside and /grants/northstar.

import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  findFpOpportunity,
  isFpStatus,
  setFpReopenWatch,
  setFpStatus,
  updateFpOpportunity,
} from "@/lib/federal-pipeline";
import { isClientId } from "@/lib/federal-pipeline-types";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ client: string; id: string }> },
) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { client, id } = await ctx.params;

  // 404, not 400: /api/grants/acme/... is a wrong address, same rule as the
  // client bid-board pages.
  if (!isClientId(client)) return Response.json({ error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    status?: unknown;
    reason?: unknown;
    reopenWatch?: unknown;
  } | null;

  // "Remind when reopens" is its own exclusive action (migration 046) — a
  // watch flip and a status transition are separate decisions and must not
  // half-apply together.
  if (body && "reopenWatch" in body) {
    const extras = Object.keys(body).filter((k) => k !== "reopenWatch");
    if (extras.length > 0) {
      return Response.json({ error: "reopen_watch_is_exclusive", got: extras }, { status: 400 });
    }
    if (typeof body.reopenWatch !== "boolean") {
      return Response.json({ error: "reopenWatch_must_be_boolean" }, { status: 400 });
    }
    try {
      const { opp, event } = setFpReopenWatch(id, body.reopenWatch, {
        by: session.email,
        clientId: client,
      });
      return Response.json({ opportunity: opp, event });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("no opportunity matches")) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({ error: message }, { status: 400 });
    }
  }

  const status = body?.status;
  if (typeof status !== "string" || !isFpStatus(status)) {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }
  const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  // A pass without a reason is not a decision — same rule the fp state
  // machine documents for triaged_nobid.
  if (status === "triaged_nobid" && !reason) {
    return Response.json({ error: "nobid_reason_required" }, { status: 400 });
  }

  // Scope gate: resolves only within this client's panel.
  const scoped = findFpOpportunity(id, client);
  if (!scoped) return Response.json({ error: "not_found" }, { status: 404 });

  try {
    if (status === "triaged_nobid") {
      updateFpOpportunity(scoped.id, { nobidReason: reason });
    }
    const note = reason ?? `decided on ${client} grants workspace by ${session.email}`;
    const { opp, event } = setFpStatus(scoped.id, status, note, client);
    return Response.json({ opportunity: opp, event });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 400 });
  }
}
