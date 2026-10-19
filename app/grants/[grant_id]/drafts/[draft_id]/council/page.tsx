import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getDraft, getSavedOpportunity } from "@/lib/db";
import { CouncilPane } from "./CouncilPane";

export const dynamic = "force-dynamic";

type Ctx = {
  params: Promise<{ grant_id: string; draft_id: string }>;
};

export default async function CouncilPage({ params }: Ctx) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { grant_id, draft_id } = await params;

  // Get the draft and verify it exists
  const draft = getDraft(draft_id, session.email);
  if (!draft) notFound();

  // Get the opportunity (grant) and verify relationship
  const opportunity = getSavedOpportunity(grant_id, session.email);
  if (!opportunity) notFound();

  // Verify that this draft is related to this opportunity
  // (In current implementation, we'll check if the draft's opportunity field matches)
  // This is a loose check since the relationship isn't strictly enforced in the schema
  if (draft.opportunity !== opportunity.title && !draft.opportunity.includes(opportunity.title)) {
    // Allow access but show a warning
    console.warn(`Draft ${draft_id} may not be related to opportunity ${grant_id}`);
  }

  return (
    <div className="mx-auto max-w-7xl px-6 pt-3">
      {/* Breadcrumb navigation */}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-stone-600">
        <Link href="/opportunities" className="font-medium text-emerald-700 hover:underline">
          ← Opportunities
        </Link>
        <span className="text-stone-300">·</span>
        <Link
          href={`/opportunities/${grant_id}`}
          className="font-medium text-emerald-700 hover:underline"
        >
          {opportunity.title}
        </Link>
        <span className="text-stone-300">·</span>
        <Link
          href={`/drafts/${draft_id}`}
          className="font-medium text-emerald-700 hover:underline"
        >
          {draft.title}
        </Link>
        <span className="text-stone-300">·</span>
        <span className="font-medium text-stone-800">Council Deliberation</span>
      </div>

      {/* Council Pane */}
      <CouncilPane
        draftId={draft_id}
        draftTitle={draft.title}
        opportunityTitle={opportunity.title}
      />
    </div>
  );
}
