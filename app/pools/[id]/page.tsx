import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getPool, listDraftsForPool } from "@/lib/db";
import PoolDetail, { type LinkedDraft } from "./detail";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function PoolDetailPage({ params }: Ctx) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const pool = getPool(id, session.email);
  if (!pool) notFound();

  const linkedDrafts: LinkedDraft[] = listDraftsForPool(id, session.email).map((d) => ({
    id: d.id,
    title: d.title,
    updatedAt: d.updatedAt,
  }));

  return (
    <PoolDetail
      user={{ email: session.email, name: session.name ?? session.email }}
      pool={pool}
      linkedDrafts={linkedDrafts}
    />
  );
}
