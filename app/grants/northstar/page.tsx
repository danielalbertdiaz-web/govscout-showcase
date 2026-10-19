import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listFpOpportunities } from "@/lib/federal-pipeline";
import { loadCronHealth } from "@/lib/cron-health";
import GrantsWorkspaceView, { type WatchingCron } from "../_components/GrantsWorkspaceView";

export const dynamic = "force-dynamic";

// Northstar Training Institute Grants Workspace (demo client, client_id
// 'northstar'). Same shape as the Riverside workspace, its own identity;
// the clientId is fixed at the query so this page can never receive another
// client's rows (PANEL_ISOLATION_SPEC.md).
export default async function NorthstarGrantsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const grants = listFpOpportunities({ clientId: "northstar", limit: 1000 });

  const crons: WatchingCron[] = loadCronHealth()
    .filter((c) => c.name.toUpperCase().includes("NORTHSTAR"))
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
      clientId="northstar"
      grants={grants}
      crons={crons}
    />
  );
}
