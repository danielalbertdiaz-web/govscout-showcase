// U-2: /opportunities is the unified opportunity view — one screen answering
// "what could I bid on?" across all five source tables, in the Bid Board's
// status-column layout. The per-source pages (/bid-board, /contracts,
// /scouts, /teaming) are untouched; saved-opportunity detail stays at
// /opportunities/[id].

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listMicroContracts, listSavedOpportunities, listTeamingNotices } from "@/lib/db";
import { listFpOpportunities } from "@/lib/federal-pipeline";
import { listAllItems } from "@/lib/scouts";
import { countBySource, unifyPipeline } from "@/lib/pipeline-summary";
import { AppHeader } from "@/app/_components/AppHeader";
import UnifiedOpportunitiesView from "./view";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const items = unifyPipeline(
    listFpOpportunities({ limit: 1000 }),
    listMicroContracts(session.email),
    listSavedOpportunities(session.email),
    listAllItems(session.email),
    listTeamingNotices(session.email),
  );
  const bySource = countBySource(items);

  return (
    <div className="mx-auto max-w-7xl px-6 pt-3 pb-16">
      <AppHeader
        tagline="Opportunities"
        title={`${items.length} tracked across the pipeline`}
        subtitle={`Bid Board ${bySource.federal} · micro ${bySource.micro} · grants ${bySource.saved} · teaming ${bySource.teaming} · scouts ${bySource.scout}`}
        userLabel={session.name ?? session.email}
        activeNav="opportunities"
      />
      <div className="mt-4">
        <UnifiedOpportunitiesView items={items} />
      </div>
    </div>
  );
}
