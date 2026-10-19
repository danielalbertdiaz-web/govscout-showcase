// Item 5.2 — /teaming list + manual scan.
//
//   GET  /api/teaming   → persisted teaming notices for the session user, plus
//                         whether a source is configured (SAM key present).
//   POST /api/teaming   → run a teaming scan now (session required). Discovers +
//                         persists only; returns counts. NOTHING is sent.

import { getSession } from "@/lib/auth";
import { listTeamingNotices } from "@/lib/db";
import { runTeamingScan } from "@/lib/teaming-scan";
import { availableTeamingSources } from "@/lib/teaming-sources/index";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const notices = listTeamingNotices(session.email);
  const sources = availableTeamingSources().map((s) => s.id);
  return Response.json({ notices, sourcesAvailable: sources, sourceConfigured: sources.length > 0 });
}

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await runTeamingScan(session.email);
  const notices = listTeamingNotices(session.email);
  return Response.json({ ok: true, sent: false, ...result, notices });
}
