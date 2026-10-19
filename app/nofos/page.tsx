import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listNofos } from "@/lib/db";
import NofosLibrary, { type NofoListItem } from "./library";

export const dynamic = "force-dynamic";

export default async function NofosPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const nofos = listNofos(session.email);
  const items: NofoListItem[] = nofos.map((n) => ({
    id: n.id,
    agency: n.agency,
    program: n.program,
    fundingFloor: n.fundingFloor,
    fundingCeiling: n.fundingCeiling,
    periodOfPerformance: n.periodOfPerformance,
    summary: n.summary,
    originalFilename: n.originalFilename,
    extractedAt: n.extractedAt,
    tags: n.tags,
    score: n.score,
    scoreRationale: n.scoreRationale,
    scoredAt: n.scoredAt,
  }));
  return <NofosLibrary user={{ email: session.email, name: session.name ?? session.email }} initial={items} />;
}
