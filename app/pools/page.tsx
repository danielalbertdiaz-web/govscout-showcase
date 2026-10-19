import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listPools } from "@/lib/db";
import PoolsView, { type PoolListItem } from "./view";

export const dynamic = "force-dynamic";

export default async function PoolsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const pools = listPools(session.email);
  const items: PoolListItem[] = pools.map((p) => ({
    id: p.id,
    rank: p.rank,
    name: p.name,
    agency: p.agency,
    jurisdiction: p.jurisdiction,
    status: p.status,
    playType: p.playType,
    allocatedAmount: p.allocatedAmount,
    unspentAmount: p.unspentAmount,
    deadlineDate: p.deadlineDate,
    deadlineLabel: p.deadlineLabel,
    fitSummary: p.fitSummary,
    nextAction: p.nextAction,
    tags: p.tags,
    updatedAt: p.updatedAt,
  }));

  return (
    <PoolsView
      user={{ email: session.email, name: session.name ?? session.email }}
      initial={items}
    />
  );
}
