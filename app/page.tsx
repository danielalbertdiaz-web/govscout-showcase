// Command-center home (2026-06-10 UX pass). The app used to land on a blank
// drafting form; a discovery-driven tool should land on "what needs my
// attention" — open decisions, approaching deadlines, drafts in flight, and
// the money the scanners found. The workbench lives at /workbench.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listDrafts, listDraftStatuses, listMicroContracts, listPools, listSavedOpportunities } from "@/lib/db";
import { listDecisions } from "@/lib/decisions";
import { listFpOpportunities } from "@/lib/federal-pipeline";
import {
  countBySource,
  isActionable,
  parseDeadlineMs,
  unifyPipeline,
  upcomingDeadlines,
  type FpInput,
  type PipelineItem,
  type PipelineSource,
} from "@/lib/pipeline-summary";
// Deadline vocabulary for the Flagged rows comes from lib/deadline.ts (D-1) —
// re-exported so tests pin function identity, same guard as the board views.
// Do not compute or format a deadline locally in this file.
export { deadlineText } from "@/lib/deadline";
import { deadlineText, deadlineTone, hoursLeft } from "@/lib/deadline";
import { AppHeader } from "@/app/_components/AppHeader";
import { DraftStatusPill } from "@/app/_components/DraftStatusPill";

export const dynamic = "force-dynamic";

const CARD = "rounded-xl border border-stone-200 bg-white p-5 shadow-sm";
const KICKER = "text-[11px] font-semibold uppercase tracking-wider text-stone-500";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// Routed through parseDeadlineMs (fix 1b follow-up) so a bare-date micro row's
// chip counts from end-of-day local like everything else — the raw Date.parse
// it used before read bare dates a day short each evening. Exported for tests.
export function daysUntil(deadline: string): number | null {
  const t = parseDeadlineMs(deadline);
  if (t == null) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

// Clock read lives in a helper (same pattern as greeting/daysUntil) — the
// page is force-dynamic, so this evaluates fresh per request.
function upcomingWithin30(pipeline: PipelineItem[]): PipelineItem[] {
  return upcomingDeadlines(pipeline, { now: Date.now(), withinDays: 30 });
}

/**
 * The priority flag's own surface (migration 041). "Upcoming deadlines" above
 * answers "what runs out first": deadline-ordered, 30-day horizon, slice(0,8),
 * and deliberately flag-blind (pinned in tests/pipeline-summary.test.ts) — so
 * a flag alone changes nothing there, and a flag that is invisible on the
 * dashboard is not a flag. This answers "what did a human single out":
 * flagged AND still actionable, with NO horizon and NO slice — visible
 * whether it is due in 3 days or 60. An item in both lists is informative,
 * not a bug; do not de-duplicate across them. Structural input (FpInput plus
 * flaggedAt) so tests pass literals. Exported for tests.
 */
export function flaggedActionable(
  fpOpps: Array<FpInput & { flaggedAt: number | null }>,
): PipelineItem[] {
  const flagged = fpOpps.filter((o) => o.flaggedAt != null);
  return unifyPipeline(flagged, [], []).filter(isActionable);
}

function deadlineChip(days: number): string {
  if (days <= 7) return "border-rose-300 bg-rose-50 text-rose-700";
  if (days <= 21) return "border-amber-300 bg-amber-50 text-amber-800";
  return "border-stone-300 bg-stone-50 text-stone-600";
}

// Source badge for unified deadline rows — the label carries the meaning,
// colour is only reinforcement.
const SOURCE_BADGE: Record<PipelineSource, { label: string; cls: string }> = {
  federal: { label: "Bid Board", cls: "border-emerald-300 bg-emerald-50 text-emerald-700" },
  micro: { label: "Micro", cls: "border-sky-300 bg-sky-50 text-sky-700" },
  saved: { label: "Saved", cls: "border-stone-300 bg-stone-50 text-stone-600" },
  // U-2 sources — not fetched on the home page (unifyPipeline is called with
  // three sources here), but the exhaustive Record needs every member.
  scout: { label: "Scout", cls: "border-violet-300 bg-violet-50 text-violet-700" },
  teaming: { label: "Teaming", cls: "border-amber-300 bg-amber-50 text-amber-800" },
};

export default async function HomePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const firstName = (session.name ?? session.email).split(/[\s@]/)[0];

  const openDecisions = listDecisions({ userEmail: session.email, status: "open" });
  const drafts = listDrafts(session.email, 50);
  const statuses = listDraftStatuses(session.email);
  const pools = listPools(session.email);
  const opps = listSavedOpportunities(session.email);

  // U-1: deadlines are graded across the whole pipeline, not just the two
  // saved_opportunities rows. listFpOpportunities already excludes archived
  // rows; micro_contracts is owner-scoped.
  const fpOpps = listFpOpportunities({});
  const pipeline = unifyPipeline(fpOpps, listMicroContracts(session.email), opps);
  const bySource = countBySource(pipeline);
  const upcoming = upcomingWithin30(pipeline);
  const flagged = flaggedActionable(fpOpps);

  const inFlight = drafts.filter((d) => {
    const s = statuses.get(d.id) ?? "drafting";
    return s === "drafting" || s === "auto_drafted";
  });

  const topPools = pools
    .filter((p) => p.status === "discovered" || p.status === "researched")
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
    .slice(0, 4);

  const stats: { label: string; value: number; href: string; accent?: boolean }[] = [
    { label: "Open decisions", value: openDecisions.length, href: "/decisions", accent: openDecisions.length > 0 },
    { label: "Drafts in flight", value: inFlight.length, href: "/drafts" },
    { label: "Funding pools", value: pools.length, href: "/pools" },
    {
      label: "Pipeline tracked",
      value: bySource.federal + bySource.micro + bySource.saved,
      href: "/bid-board",
    },
    { label: "Needs action ≤ 30d", value: upcoming.length, href: "/calendar" },
    // Entry point to the Riverside client workspace — a distinct pane, not a
    // Bid Board view (2026-08-25 build spec). Count = grants awaiting a
    // go/no-go decision, the number the operator actually clears.
    {
      label: "Riverside review queue",
      value: fpOpps.filter((o) => o.clientId === "riverside" && o.status === "discovered").length,
      href: "/grants/riverside",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Command center"
        title={`${greeting()}, ${firstName}`}
        subtitle="Everything that needs your attention, in one glance."
        userLabel={session.name ?? session.email}
      />

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className={`${CARD} transition hover:border-emerald-400 hover:shadow ${
              s.accent ? "border-amber-300 bg-amber-50/60" : ""
            }`}
          >
            <div className={KICKER}>{s.label}</div>
            <div className={`mt-1 text-3xl font-bold ${s.accent ? "text-amber-700" : "text-stone-900"}`}>
              {s.value}
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="space-y-4 lg:col-span-2">
          <div className={CARD}>
            <div className="flex items-center justify-between">
              <h2 className={KICKER}>Needs your attention</h2>
              <Link href="/decisions" className="text-xs font-semibold text-emerald-700 hover:text-emerald-900">
                Decision queue →
              </Link>
            </div>
            {openDecisions.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">
                Nothing waiting on you — the pipeline is clear. ✓
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-stone-100">
                {openDecisions.slice(0, 5).map((d) => (
                  <li key={d.id} className="py-2.5">
                    <Link href="/decisions" className="group block">
                      <span className="text-sm font-medium text-stone-900 group-hover:text-emerald-700">
                        {d.question}
                      </span>
                      {d.recommendedOption && (
                        <span className="mt-0.5 block text-xs text-stone-500">
                          Recommended: {d.recommendedOption}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Flagged (migration 041): renders ONLY when something is flagged —
              an empty labelled box is the "DEADLINES ≤ 30D: 0" credibility
              failure again. Not horizon-limited, not sliced, and separate
              from the deadline list below on purpose: "what did a human
              single out" vs "what runs out first". */}
          {flagged.length > 0 && (
            <div className={CARD}>
              <div className="flex items-center justify-between">
                <h2 className={KICKER}>Flagged</h2>
                <Link href="/bid-board" className="text-xs font-semibold text-emerald-700 hover:text-emerald-900">
                  Bid Board →
                </Link>
              </div>
              <ul className="mt-3 divide-y divide-stone-100">
                {flagged.map((i) => (
                  <li key={`${i.source}-${i.id}`} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link href={i.href} className="group block">
                        <div className="truncate text-sm font-medium text-stone-900 group-hover:text-emerald-700">
                          {i.title}
                        </div>
                        <div className="text-xs text-stone-500">{i.agency ?? "—"}</div>
                      </Link>
                    </div>
                    <span className={`shrink-0 text-xs ${deadlineTone(hoursLeft(i.deadline))}`}>
                      {deadlineText(i.deadline)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={CARD}>
            <div className="flex items-center justify-between">
              <h2 className={KICKER}>Upcoming deadlines</h2>
              <Link href="/calendar" className="text-xs font-semibold text-emerald-700 hover:text-emerald-900">
                All deadlines →
              </Link>
            </div>
            {upcoming.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">
                No live deadlines across the pipeline. Find the next one in{" "}
                <Link href="/search" className="font-semibold text-emerald-700 hover:underline">
                  Search
                </Link>{" "}
                or{" "}
                <Link href="/teaming" className="font-semibold text-emerald-700 hover:underline">
                  Teaming
                </Link>
                .
              </p>
            ) : (
              <>
                <ul className="mt-3 divide-y divide-stone-100">
                  {upcoming.slice(0, 8).map((i) => {
                    const days = daysUntil(i.deadline!) ?? 0;
                    const badge = SOURCE_BADGE[i.source];
                    return (
                      <li key={`${i.source}-${i.id}`} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <Link href={i.href} className="group block">
                            <div className="truncate text-sm font-medium text-stone-900 group-hover:text-emerald-700">
                              {i.title}
                            </div>
                            <div className="text-xs text-stone-500">{i.agency ?? "—"}</div>
                          </Link>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}
                          >
                            {badge.label}
                          </span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${deadlineChip(days)}`}
                          >
                            {days === 0 ? "today" : `${days}d left`}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {upcoming.length > 8 && (
                  <Link
                    href="/calendar"
                    className="mt-2 block text-xs font-semibold text-emerald-700 hover:text-emerald-900"
                  >
                    {upcoming.length - 8} more within 30 days →
                  </Link>
                )}
              </>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className={CARD}>
            <div className="flex items-center justify-between">
              <h2 className={KICKER}>Drafts in flight</h2>
              <Link href="/drafts" className="text-xs font-semibold text-emerald-700 hover:text-emerald-900">
                All →
              </Link>
            </div>
            {inFlight.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">No active drafts.</p>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {inFlight.slice(0, 5).map((d) => (
                  <li key={d.id}>
                    <Link href={`/drafts/${d.id}`} className="group flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-stone-900 group-hover:text-emerald-700">
                        {d.title}
                      </span>
                      <DraftStatusPill status={statuses.get(d.id) ?? "drafting"} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={CARD}>
            <div className="flex items-center justify-between">
              <h2 className={KICKER}>Money on the table</h2>
              <Link href="/pools" className="text-xs font-semibold text-emerald-700 hover:text-emerald-900">
                All pools →
              </Link>
            </div>
            {topPools.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">No discovered pools yet — run a scan from /pools.</p>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {topPools.map((p) => (
                  <li key={p.id}>
                    <Link href={`/pools/${p.id}`} className="group block">
                      <div className="truncate text-sm font-medium text-stone-900 group-hover:text-emerald-700">
                        {p.name}
                      </div>
                      {p.unspentAmount && (
                        <div className="text-xs font-semibold text-emerald-700">{p.unspentAmount}</div>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
