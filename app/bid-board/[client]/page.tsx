import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listFpOpportunities, latestFpEventByOpp } from "@/lib/federal-pipeline";
import { isClientId, type FpEvent } from "@/lib/federal-pipeline-types";
import BidBoardView from "../view";

export const dynamic = "force-dynamic";

// One client's panel (migration 043). The clientId is fixed by the route and
// applied at the query — the view never receives another panel's rows, so
// there is nothing client-side to filter (or to leak).
export default async function ClientBidBoardPage(props: { params: Promise<{ client: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { client } = await props.params;
  // 404, not a redirect: /bid-board/acme is a wrong address, and quietly
  // landing a typo on some default panel is how a row gets misread as
  // another client's pipeline.
  if (!isClientId(client)) notFound();

  const opportunities = listFpOpportunities({ clientId: client, limit: 1000 });

  // Latest "the government talked to us" event per opp (waiting-on-response
  // column) and latest submission event (days-since-submission buckets).
  // Keyed by opp id, so panel scope is inherited from the list above.
  const contactMap = latestFpEventByOpp([
    "co_reply_received",
    "qa_answered",
    "amendment_posted",
    "award_posted",
  ]);
  const submittedMap = latestFpEventByOpp(["submitted"]);

  const lastContact: Record<string, FpEvent> = {};
  for (const [oppId, ev] of contactMap) lastContact[oppId] = ev;
  const lastSubmitted: Record<string, FpEvent> = {};
  for (const [oppId, ev] of submittedMap) lastSubmitted[oppId] = ev;

  return (
    <BidBoardView
      user={{ email: session.email, name: session.name ?? session.email }}
      client={client}
      opportunities={opportunities}
      lastContact={lastContact}
      lastSubmitted={lastSubmitted}
    />
  );
}
