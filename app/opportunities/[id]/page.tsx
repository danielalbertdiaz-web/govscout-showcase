import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSavedOpportunity } from "@/lib/db";
import { AppHeader } from "@/app/_components/AppHeader";
import AutoDraftButton from "./auto-draft";
import DispositionControl from "./disposition-control";
import PartnerFitPanel from "./partner-fit-panel";
import NonprofitScannerPanel from "./nonprofit-scanner-panel";

export const dynamic = "force-dynamic";

export default async function OpportunityDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const opp = getSavedOpportunity(id, session.email);
  if (!opp) notFound();

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="Saved opportunity"
        title={opp.title}
        subtitle={[opp.agency, opp.deadline ? `Deadline: ${opp.deadline}` : null]
          .filter(Boolean)
          .join(" · ")}
        userLabel={session.name ?? session.email}
        activeNav="opportunities"
        leadingActions={
          <Link
            href="/opportunities"
            className="rounded-md border border-stone-400 bg-white/80 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            ← All saved
          </Link>
        }
      />

      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-stone-600">
          Facts
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {opp.agency && <Row label="Agency" value={opp.agency} />}
          {opp.deadline && <Row label="Deadline" value={opp.deadline} />}
          {(opp.fundingFloor || opp.fundingCeiling) && (
            <Row
              label="Funding"
              value={`${opp.fundingFloor ?? "?"} – ${opp.fundingCeiling ?? "?"}`}
            />
          )}
          {opp.naics && <Row label="NAICS" value={opp.naics} />}
          {opp.eligibility && <Row label="Eligibility" value={opp.eligibility} />}
          {opp.url && (
            <Row
              label="Source"
              value={
                <a
                  href={opp.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-700 underline"
                >
                  {opp.url} ↗
                </a>
              }
            />
          )}
        </dl>
        {opp.summary && (
          <>
            <h3 className="mt-5 mb-2 text-sm font-semibold uppercase tracking-wider text-stone-600">
              Summary
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-6 text-stone-800">
              {opp.summary}
            </p>
          </>
        )}
      </section>

      <section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-emerald-900">
          Draft this proposal
        </h2>
        <p className="mt-1 text-xs text-emerald-900/80">
          One-click full draft — Executive Summary → Capability Statement → Technical
          Approach → Past Performance → Reviewer Notes. Streams progress in place,
          saves to the Drafts library when done.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <AutoDraftButton opportunityId={opp.id} />
          <Link
            href={`/?save=${opp.id}`}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            Open in workbench
          </Link>
        </div>
      </section>

      <PartnerFitPanel opportunityId={opp.id} />

      <NonprofitScannerPanel opportunityId={opp.id} />

      <DispositionControl
        opportunityId={opp.id}
        initialDisposition={opp.disposition}
        initialNote={opp.dispositionNote}
        initialAt={opp.dispositionAt}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
        {label}
      </dt>
      <dd className="text-sm text-stone-800">{value}</dd>
    </div>
  );
}
