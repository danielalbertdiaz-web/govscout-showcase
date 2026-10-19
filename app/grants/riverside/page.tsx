import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listFpOpportunities } from "@/lib/federal-pipeline";
import { loadCronHealth } from "@/lib/cron-health";
import GrantsWorkspaceView, { type WatchingCron } from "../_components/GrantsWorkspaceView";

export const dynamic = "force-dynamic";

// Riverside Grants Workspace (2026-08-25 build spec). The clientId is fixed at
// the query — this page can never receive another client's rows
// (PANEL_ISOLATION_SPEC.md).
export default async function RiversideGrantsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const grants = listFpOpportunities({ clientId: "riverside", limit: 1000 });

  // The discovery/watch crons feeding this board (OpenClaw owns scheduling;
  // GovScout observes read-only, same as /cron-health). Matched by name —
  // every Riverside job is named "Riverside ..." by convention.
  const crons: WatchingCron[] = loadCronHealth()
    .filter((c) => c.name.toUpperCase().includes("RIVERSIDE"))
    .map((c) => ({
      id: c.id,
      name: c.name,
      scheduleExpr: c.scheduleExpr,
      tz: c.tz,
      status: c.status,
      lastRunAtMs: c.lastRunAtMs,
    }));

  return (
    <GrantsWorkspaceView
      user={{ email: session.email, name: session.name ?? session.email }}
      clientId="riverside"
      grants={grants}
      crons={crons}
    />
  );
}
