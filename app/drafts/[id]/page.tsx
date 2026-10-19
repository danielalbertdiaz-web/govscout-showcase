import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { listBlocks } from "@/lib/blocks";
import { getDraft, getNofoSummary, getPoolSummary, listVersions } from "@/lib/db";
import { sectionTitle } from "@/lib/sections";
import Workbench, { type SerializedDraft } from "@/app/workbench/workbench-client";
import PoolLinkChooser from "./pool-link";
import SnapshotPanel from "./snapshot-panel";
import BoilerplatePicker from "./boilerplate-picker";
import PreflightPanel from "./preflight-panel";
import BudgetPanel from "./budget-panel";
import CouncilPane from "./council-pane";
import GoNoGoPanel from "./go-no-go-panel";
import SynthesizerPanel from "./synthesizer-panel";
import PartnerRoster from "./partner-roster";
import WorkingDraftPane from "./working-draft-pane";
import { SuggestionInbox } from "@/app/_components/SuggestionInbox";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function AutoDraftFlagsBanner({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta) return null;
  const autoDrafted = meta.autoDrafted === true;
  const flags = (meta.flags as Record<string, unknown> | undefined) ?? {};
  const scoreDropped = flags.score_dropped_after_autodraft as
    | { from: number; to: number; threshold: number; reason: string; at: number }
    | undefined;
  const noPartnerMatched = flags.no_partner_matched as { at: number } | undefined;
  if (!autoDrafted && !scoreDropped && !noPartnerMatched) return null;
  const triggerScore = (meta.triggerScore as number | undefined) ?? null;
  return (
    <section className="mt-4 rounded-xl border border-amber-300 bg-amber-50/40 p-4 text-xs text-amber-900 shadow-sm">
      <header className="flex items-center justify-between">
        <span className="text-sm font-semibold">⚙ Auto-drafted</span>
        {triggerScore != null && (
          <span className="text-[11px] opacity-80">
            triggered at score {Math.round(triggerScore)}/100
          </span>
        )}
      </header>
      <ul className="mt-2 space-y-1">
        {autoDrafted && (
          <li>
            This draft was assembled automatically. Review every section before any submission
            action. Submission still requires pre-flight to clear (or an explicit override).
          </li>
        )}
        {scoreDropped && (
          <li className="rounded border border-rose-300 bg-rose-50 px-2 py-1 text-rose-900">
            ⚠ Score dropped after auto-draft: {scoreDropped.from} → {scoreDropped.to} (threshold{" "}
            {scoreDropped.threshold}, reason: {scoreDropped.reason}). Re-evaluate fit before
            investing more time.
          </li>
        )}
        {noPartnerMatched && (
          <li className="rounded border border-amber-400 bg-amber-100 px-2 py-1">
            ⚠ No warm partner matched at draft time. The technical-approach section is a skeleton —
            assign consortium partners before submission.
          </li>
        )}
      </ul>
    </section>
  );
}

export default async function DraftDetailPage({ params }: Ctx) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const draft = getDraft(id, session.email);
  if (!draft) notFound();
  const versions = listVersions(id, session.email);
  const blocks = await listBlocks();
  const linkedNofo = draft.nofoId ? getNofoSummary(draft.nofoId, session.email) : null;
  const linkedPool = draft.poolId ? getPoolSummary(draft.poolId, session.email) : null;

  const initial: SerializedDraft = {
    id: draft.id,
    title: draft.title,
    business: draft.business,
    naics: draft.naics,
    opportunity: draft.opportunity,
    blocks: draft.blocks,
    structured: draft.structured,
    sections: draft.sections,
  };

  return (
    <div className="mx-auto max-w-7xl px-6 pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-stone-600">
        <Link href="/drafts" className="font-medium text-emerald-700 hover:underline">
          ← Drafts
        </Link>
        <span className="text-stone-300">·</span>
        <span>
          {versions.length} version{versions.length === 1 ? "" : "s"} on file
        </span>
        {linkedNofo && (
          <>
            <span className="text-stone-300">·</span>
            <Link
              href={`/nofos/${linkedNofo.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100"
              title="View this draft's source NOFO"
            >
              <span>📎</span>
              <span className="max-w-[24rem] truncate">
                Linked NOFO: {[linkedNofo.agency, linkedNofo.program].filter(Boolean).join(" — ") || linkedNofo.id}
              </span>
            </Link>
          </>
        )}
        {linkedPool && (
          <>
            <span className="text-stone-300">·</span>
            <Link
              href={`/pools/${linkedPool.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
              title="View linked funding pool"
            >
              <span>💰</span>
              <span className="max-w-[24rem] truncate">
                Pool: {linkedPool.name}
              </span>
            </Link>
          </>
        )}
        <span className="text-stone-300">·</span>
        <PoolLinkChooser draftId={draft.id} currentPoolId={draft.poolId} />
      </div>
      <AutoDraftFlagsBanner meta={draft.meta} />
      <Workbench
        user={{ email: session.email, name: session.name ?? session.email }}
        blocks={blocks}
        initialDraft={initial}
      />
      <PartnerRoster draftId={draft.id} />
      <SynthesizerPanel draftId={draft.id} />
      <WorkingDraftPane
        draftId={draft.id}
        documentTitle={
          [linkedNofo?.agency, linkedNofo?.program].filter(Boolean).join(" — ") ||
          draft.opportunity ||
          draft.title
        }
      />
      <GoNoGoPanel draftId={draft.id} />
      <CouncilPane
        draftId={draft.id}
        draftTitle={draft.title}
        opportunityTitle={
          [linkedNofo?.agency, linkedNofo?.program].filter(Boolean).join(" — ") ||
          draft.opportunity ||
          draft.title
        }
      />
      <BoilerplatePicker draftId={draft.id} />
      <div className="mt-4">
        <BudgetPanel
          draftId={draft.id}
          initial={(draft.meta?.budget as import("@/lib/budget").BudgetInput | undefined) ?? null}
        />
      </div>
      <PreflightPanel draftId={draft.id} />
      <SnapshotPanel draftId={draft.id} />
      <div className="mt-4">
        <SuggestionInbox paneContextType="draft" paneContextId={draft.id} />
      </div>
      {versions.length > 0 && (
        <details className="mx-auto mb-10 mt-4 max-w-7xl rounded-xl border border-stone-200 bg-white p-4 text-xs text-stone-700 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-emerald-700">
            Version history ({versions.length})
          </summary>
          <ol className="mt-3 space-y-3">
            {versions
              .slice()
              .reverse()
              .map((v) => (
                <li key={v.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold text-stone-900">
                        {v.kind === "section" && v.section ? sectionTitle(v.section) : "Full draft"}
                      </span>
                      <span className="ml-2 text-stone-500">{new Date(v.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  {v.instruction && (
                    <div className="mt-1 text-[11px] italic text-stone-600">Instruction: {v.instruction}</div>
                  )}
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px] leading-5 text-stone-800 ring-1 ring-stone-200">
                    {v.text}
                  </pre>
                </li>
              ))}
          </ol>
        </details>
      )}
    </div>
  );
}
