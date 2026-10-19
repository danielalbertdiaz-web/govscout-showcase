import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listDrafts, listDraftStatuses } from "@/lib/db";
import { AppHeader } from "@/app/_components/AppHeader";
import { DraftStatusPill } from "@/app/_components/DraftStatusPill";
import { SuggestionInbox } from "@/app/_components/SuggestionInbox";

export const dynamic = "force-dynamic";

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}

export default async function DraftsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const drafts = listDrafts(session.email);
  const statuses = listDraftStatuses(session.email);
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="Draft history"
        title={`${drafts.length} draft${drafts.length === 1 ? "" : "s"} on file`}
        subtitle="Every proposal in progress, with full version history. Edits auto-save."
        userLabel={session.name ?? session.email}
        activeNav="drafts"
      />

      <SuggestionInbox paneContextType="drafts" />

      {drafts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/brand/empty-state.png"
            alt=""
            aria-hidden
            className="mx-auto mb-3 h-28 w-28 rounded-xl object-cover"
          />
          <p className="text-sm font-medium text-stone-800">No drafts saved yet.</p>
          <p className="mt-2 text-xs leading-5 text-stone-500">
            Head to the workbench, load an opportunity, and draft a section. We&rsquo;ll save it here automatically with full version history.
          </p>
          <Link
            href="/workbench"
            className="mt-4 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500"
          >
            Go to workbench →
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {drafts.map((d) => {
            const sub = [d.structured?.agency, d.structured?.program].filter(Boolean).join(" — ");
            const sectionCount = Object.values(d.sections).filter((s) => s.trim()).length;
            return (
              <li key={d.id} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        href={`/drafts/${d.id}`}
                        className="block truncate text-base font-semibold text-emerald-700 hover:underline"
                      >
                        {d.title}
                      </Link>
                      <DraftStatusPill status={statuses.get(d.id) ?? "drafting"} />
                    </div>
                    {sub && <div className="mt-0.5 text-sm text-stone-700">{sub}</div>}
                    <div className="mt-1 text-xs text-stone-500">
                      {sectionCount}/5 sections · {d.blocks.length} blocks · updated {fmtDate(d.updatedAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={`/api/drafts/${d.id}/docx`}
                      className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
                    >
                      .docx
                    </a>
                    <Link
                      href={`/drafts/${d.id}`}
                      className="rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                    >
                      Open
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
