import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listAgencies, trackLStats } from "@/lib/track-l";
import TrackLView from "./view";

export const dynamic = "force-dynamic";

export default async function TrackLPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // First page server-rendered; the client refetches through /api/track-l as
  // filters change (§6a).
  const { rows, total } = listAgencies({ limit: 100 });
  const stats = trackLStats();

  return (
    <TrackLView
      user={{ email: session.email, name: session.name ?? session.email }}
      initialAgencies={rows}
      initialTotal={total}
      stats={stats}
    />
  );
}
