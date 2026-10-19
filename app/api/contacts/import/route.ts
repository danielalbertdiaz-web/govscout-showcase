// POST /api/contacts/import — Item 4.3
// Import LinkedIn connections (from the version-controlled index) into the
// contacts table as cold-outreach leads. Idempotent: re-running skips leads
// already present. Reports available vs claimed counts so the data gap is
// visible. NOTHING is sent — this only creates contact records.

import { getSession } from "@/lib/auth";
import { importLinkedinConnections } from "@/lib/linkedin-import";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await importLinkedinConnections(session.email);
  return Response.json({
    ok: true,
    available: result.available,
    totalClaimed: result.totalClaimed,
    imported: result.imported,
    skipped: result.skipped,
    // surface the gap explicitly for the UI note
    note:
      result.totalClaimed && result.totalClaimed > result.available
        ? `Index claims ${result.totalClaimed} connections but only ${result.available} are enriched and importable.`
        : null,
  });
}
