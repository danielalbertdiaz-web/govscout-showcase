import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listDigests } from "@/lib/scouts";
import ScoutsView, { type DigestListItem } from "./view";

export const dynamic = "force-dynamic";

export default async function ScoutsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const digests = listDigests(session.email);
  const initial: DigestListItem[] = digests.map((d) => ({
    id: d.id,
    cronJobId: d.cronJobId,
    sourceLabel: d.sourceLabel,
    ranAtMs: d.ranAtMs,
    status: d.status,
    summaryPreview: d.summary.slice(0, 280),
    itemCount: d.itemCount,
    interestedCount: d.interestedCount,
    newCount: d.newCount,
  }));

  return (
    <ScoutsView
      user={{ email: session.email, name: session.name ?? session.email }}
      initial={initial}
    />
  );
}
