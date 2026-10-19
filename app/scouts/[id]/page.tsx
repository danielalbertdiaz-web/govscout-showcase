import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDigest, listItemsForDigest } from "@/lib/scouts";
import { listPools } from "@/lib/db";
import DigestDetailView, { type PoolPickOption } from "./view";

export const dynamic = "force-dynamic";

export default async function DigestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const digest = getDigest(id, session.email);
  if (!digest) notFound();
  const items = listItemsForDigest(id, session.email);

  const pools = listPools(session.email);
  const poolOptions: PoolPickOption[] = pools.map((p) => ({
    id: p.id,
    name: p.name,
    agency: p.agency,
    status: p.status,
  }));

  return (
    <DigestDetailView
      user={{ email: session.email, name: session.name ?? session.email }}
      digest={{
        id: digest.id,
        cronJobId: digest.cronJobId,
        sourceLabel: digest.sourceLabel,
        ranAtMs: digest.ranAtMs,
        summary: digest.summary,
        model: digest.model,
        durationMs: digest.durationMs,
      }}
      initialItems={items.map((it) => ({
        id: it.id,
        source: it.source,
        title: it.title,
        agency: it.agency,
        deadlineText: it.deadlineText,
        fundingText: it.fundingText,
        naics: it.naics,
        url: it.url,
        rawText: it.rawText,
        status: it.status,
        poolId: it.poolId,
        notes: it.notes,
        score: it.score,
        scoreRationale: it.scoreRationale,
        scoredAt: it.scoredAt,
      }))}
      poolOptions={poolOptions}
    />
  );
}
