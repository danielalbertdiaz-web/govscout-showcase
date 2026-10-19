"use client";

// Item 1.5: this file used to be a dead placeholder that told users to
// "navigate through the grant opportunity route." That route's pane is keyed
// purely by draftId (`/api/drafts/:draftId/council`), so it works fine from the
// draft view. This is now a thin adapter that renders the real, working pane —
// no council logic is duplicated here.

import { CouncilPane as WorkingCouncilPane } from "@/app/grants/[grant_id]/drafts/[draft_id]/council/CouncilPane";

type CouncilPaneProps = {
  draftId: string;
  draftTitle?: string;
  opportunityTitle?: string;
};

export default function CouncilPane({ draftId, draftTitle, opportunityTitle }: CouncilPaneProps) {
  return (
    <div className="mt-6">
      <WorkingCouncilPane
        draftId={draftId}
        draftTitle={draftTitle ?? "Draft"}
        opportunityTitle={opportunityTitle ?? draftTitle ?? "Opportunity"}
      />
    </div>
  );
}
