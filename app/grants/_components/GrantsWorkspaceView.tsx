"use client";

// Client Grants Workspace — a grants pane, not a procurement board.
//
// Deliberately distinct from BidBoardView (2026-08-25 build spec): no NAICS,
// no set-aside, no price-quoted/basis, no competitors, no price-band
// scoreboard — none of those exist for a grant, and their presence is what
// made the Bid Board read as "Acme's procurement board." Shares only the
// /api/grants/[client] status-transition API (which reuses setFpStatus
// server-side) and the FpOpportunity type. Visual identity is standalone —
// no gs-chrome — and themed per client, per PANEL_ISOLATION_SPEC.md: a
// client-facing screenshot must not read as another client's product.
//
// One component, one client per page: each /grants/<client> page fixes the
// clientId server-side at the query, so this view never holds another
// panel's rows.

import { useMemo, useState } from "react";
import type { ClientId, FpOpportunity, FpStatus } from "@/lib/federal-pipeline-types";
import { OTHER_CATEGORY, categoriesFor, categorizeGrant, categoryLabel } from "@/lib/grant-categories";

// Literal class strings on purpose — Tailwind's scanner reads this file.
const THEMES = {
  riverside: {
    watchLabel: "Riverside",
    orgLine: "Riverside Community Action Corp.",
    subtitle: "Federal, NJ state & county funding — discovered daily, reviewed here",
    footer:
      "Fed by the daily 7:05am Riverside Statewide Grant + RFP Watch (plus weekly foundation & forecast watches). Pursue/Pass decisions land on the opportunity's event trail; a pass requires a reason.",
    pageBg: "min-h-screen bg-emerald-50/40",
    headerBg: "border-b border-emerald-200 bg-emerald-900 px-6 py-4 text-white",
    orgCls: "text-[11px] font-semibold uppercase tracking-widest text-emerald-300",
    subtitleCls: "mt-0.5 text-xs text-emerald-100/70",
    statsCls: "text-right text-xs text-emerald-100/80",
    userCls: "mt-0.5 text-emerald-200/60",
    tabOn: "border-emerald-700 bg-emerald-700 text-white",
    tabOff: "border-emerald-200 bg-white text-emerald-900 hover:bg-emerald-100",
    card: "rounded-xl border border-emerald-200 bg-white",
    kicker: "text-[11px] font-semibold uppercase tracking-wider text-emerald-900/50",
    theadCls: "border-b border-emerald-100 bg-emerald-50/60 text-[11px] uppercase tracking-wider text-emerald-900/60",
    amountCls: "whitespace-nowrap px-4 py-3 text-sm font-semibold text-emerald-800",
    monthCls: "text-sm font-semibold uppercase tracking-wider text-emerald-900/70",
    timelineBorder: "mt-2 space-y-1.5 border-l-2 border-emerald-200 pl-4",
    pursueBtn: "rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40",
    cronPillOk: "border-emerald-200 bg-white text-emerald-900",
    cronMeta: "text-emerald-900/40",
  },
  northstar: {
    watchLabel: "Northstar Training Institute",
    orgLine: "Northstar Training Institute — Construction Safety Training Nonprofit (FL)",
    subtitle: "Workplace-safety vocational training & job placement funding — federal, FL state & foundations",
    footer:
      "Fed by the Mon/Thu Northstar Training Institute FL Safety-Training Nonprofit Grant Watch. Pursue/Pass decisions land on the opportunity's event trail; a pass requires a reason.",
    pageBg: "min-h-screen bg-amber-50/40",
    headerBg: "border-b border-amber-200 bg-stone-900 px-6 py-4 text-white",
    orgCls: "text-[11px] font-semibold uppercase tracking-widest text-amber-400",
    subtitleCls: "mt-0.5 text-xs text-amber-100/70",
    statsCls: "text-right text-xs text-amber-100/80",
    userCls: "mt-0.5 text-amber-200/60",
    tabOn: "border-amber-600 bg-amber-600 text-white",
    tabOff: "border-amber-300 bg-white text-stone-800 hover:bg-amber-100",
    card: "rounded-xl border border-amber-200 bg-white",
    kicker: "text-[11px] font-semibold uppercase tracking-wider text-stone-500",
    theadCls: "border-b border-amber-100 bg-amber-50/60 text-[11px] uppercase tracking-wider text-stone-500",
    amountCls: "whitespace-nowrap px-4 py-3 text-sm font-semibold text-amber-800",
    monthCls: "text-sm font-semibold uppercase tracking-wider text-stone-600",
    timelineBorder: "mt-2 space-y-1.5 border-l-2 border-amber-300 pl-4",
    pursueBtn: "rounded-md bg-amber-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-40",
    cronPillOk: "border-amber-300 bg-white text-stone-800",
    cronMeta: "text-stone-400",
  },
} as const;

type WorkspaceClientId = keyof typeof THEMES;

export type WatchingCron = {
  id: string;
  name: string;
  scheduleExpr: string | null;
  tz: string | null;
  status: string;
  lastRunAtMs: number | null;
};

type Props = {
  user: { email: string; name: string };
  clientId: ClientId & WorkspaceClientId;
  grants: FpOpportunity[];
  crons: WatchingCron[];
};

type Tab = "review" | "all" | "timeline" | "reopen";

// Grant-appropriate labels for the shared fp status machine.
const STATUS_LABELS: Record<FpStatus, { label: string; cls: string }> = {
  discovered: { label: "New", cls: "bg-sky-50 text-sky-700 border-sky-200" },
  triaged_bid: { label: "Pursuing", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  triaged_watch: { label: "Watching", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  triaged_nobid: { label: "Passed", cls: "bg-stone-100 text-stone-500 border-stone-200" },
  drafting: { label: "Drafting", cls: "bg-violet-50 text-violet-700 border-violet-200" },
  awaiting_approval: { label: "Awaiting review", cls: "bg-orange-50 text-orange-700 border-orange-200" },
  submitted: { label: "Submitted", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  qa_open: { label: "Q&A open", cls: "bg-cyan-50 text-cyan-700 border-cyan-200" },
  closed_won: { label: "Awarded", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  closed_lost: { label: "Not awarded", cls: "bg-rose-50 text-rose-600 border-rose-200" },
  closed_no_award: { label: "No award made", cls: "bg-stone-100 text-stone-500 border-stone-200" },
  withdrawn: { label: "Withdrawn", cls: "bg-stone-100 text-stone-500 border-stone-200" },
};

function levelOf(source: FpOpportunity["source"]): "Federal" | "State" | "County" | "Other" {
  if (source === "state") return "State";
  if (source === "county") return "County";
  if (source === "sam" || source === "other") return "Federal";
  return "Other";
}

const LEVEL_CLS: Record<string, string> = {
  Federal: "bg-indigo-50 text-indigo-700 border-indigo-200",
  State: "bg-teal-50 text-teal-700 border-teal-200",
  County: "bg-lime-50 text-lime-700 border-lime-200",
  Other: "bg-stone-50 text-stone-600 border-stone-200",
};

function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null;
  const d = new Date(`${deadline.slice(0, 10)}T23:59:59`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

function DeadlineBadge({ deadline }: { deadline: string | null }) {
  const days = daysUntil(deadline);
  if (deadline == null || days == null) {
    return <span className="text-xs italic text-stone-400">not posted</span>;
  }
  const cls =
    days < 0
      ? "bg-stone-100 text-stone-400 border-stone-200"
      : days <= 7
        ? "bg-rose-50 text-rose-700 border-rose-200"
        : days <= 21
          ? "bg-amber-50 text-amber-700 border-amber-200"
          : "bg-emerald-50 text-emerald-700 border-emerald-200";
  const label = days < 0 ? "passed" : days === 0 ? "today" : `${days}d left`;
  return (
    <span className="whitespace-nowrap">
      <span className="text-xs text-stone-600">{deadline.slice(0, 10)}</span>{" "}
      <span className={`ml-1 inline-block rounded border px-1.5 py-0.5 text-[11px] font-semibold ${cls}`}>
        {label}
      </span>
    </span>
  );
}

// First dollar-amount-looking token from the description — display aid only,
// the free text stays authoritative (see migration 044 header for why this
// is not a parsed column).
function extractAmount(description: string | null): string | null {
  if (!description) return null;
  const m = description.match(/\$[\d][\d.,]*\s*(?:[MKB]\b|million|billion|thousand)?/i);
  return m ? m[0].trim() : null;
}

// Public-awareness component flag (2026-08-26): the discovery crons append
// "PUBLIC-AWARENESS COMPONENT: ..." to the description when a NOFO allows or
// mandates an outreach/media/education budget line inside the award. The
// exact-marker match is the crons' positive finding; the keyword fallback
// catches older rows the crons wrote before the instruction existed.
function publicAwarenessNote(description: string | null): string | null {
  if (!description) return null;
  const marker = description.match(/PUBLIC[- ]AWARENESS COMPONENT:\s*([^\n]*)/i);
  if (marker) return marker[1].trim() || "component identified";
  if (/(media|awareness|public education|outreach) campaign|public awareness/i.test(description)) {
    return "likely — mentions an awareness/outreach campaign";
  }
  return null;
}

function PaBadge({ description }: { description: string | null }) {
  const note = publicAwarenessNote(description);
  if (!note) return null;
  return (
    <span
      title={`Public-awareness budget component: ${note}`}
      className="rounded border border-fuchsia-300 bg-fuchsia-50 px-1.5 py-0.5 text-[11px] font-semibold text-fuchsia-700"
    >
      📢 Public awareness $
    </span>
  );
}

// Deadline-ascending with "no deadline" last — the order a grants calendar
// reads in. Flag ordering deliberately not inherited from the Bid Board.
function byDeadline(a: FpOpportunity, b: FpOpportunity): number {
  if (!a.responseDeadline && !b.responseDeadline) return b.updatedAt - a.updatedAt;
  if (!a.responseDeadline) return 1;
  if (!b.responseDeadline) return -1;
  return a.responseDeadline.localeCompare(b.responseDeadline);
}

// cron expr → the plain-language cadence a non-operator reads. Falls back to
// the raw expression rather than guessing.
function cadenceLabel(expr: string | null): string {
  if (!expr) return "unscheduled";
  const m = expr.trim().match(/^(\d+) (\d+) \* \* (\*|[\d,-]+)$/);
  if (!m) return expr;
  const [, min, hr, dow] = m;
  const time = `${Number(hr) % 12 === 0 ? 12 : Number(hr) % 12}:${min.padStart(2, "0")}${Number(hr) < 12 ? "am" : "pm"}`;
  const DOW: Record<string, string> = {
    "*": "daily",
    "1-5": "weekdays",
    "1": "Mondays",
    "2": "Tuesdays",
    "3": "Wednesdays",
    "4": "Thursdays",
    "5": "Fridays",
    "1,3,5": "Mon/Wed/Fri",
  };
  return `${DOW[dow] ?? `days ${dow}`} ${time}`;
}

export default function GrantsWorkspaceView({ user, clientId, grants: initial, crons }: Props) {
  const T = THEMES[clientId];
  const [grants, setGrants] = useState<FpOpportunity[]>(initial);
  const [tab, setTab] = useState<Tab>("review");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [passingId, setPassingId] = useState<string | null>(null);
  const [passReason, setPassReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  // Category is derived, not stored — see lib/grant-categories.ts.
  const categoryOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of grants) m.set(g.id, categorizeGrant(clientId, g.title, g.description));
    return m;
  }, [grants]);

  const filtered = useMemo(
    () => (categoryFilter ? grants.filter((g) => categoryOf.get(g.id) === categoryFilter) : grants),
    [grants, categoryFilter, categoryOf],
  );

  // Reopen-watched rows leave the go/no-go queue: "watch for next cycle" IS
  // the decision for a passed-deadline row.
  const reviewQueue = useMemo(
    () => filtered.filter((g) => g.status === "discovered" && g.reopenWatchAt == null).sort(byDeadline),
    [filtered],
  );
  const reopenList = useMemo(
    () => filtered.filter((g) => g.reopenWatchAt != null).sort(byDeadline),
    [filtered],
  );
  const sorted = useMemo(() => [...filtered].sort(byDeadline), [filtered]);

  // Category chips: every category that has at least one grant, plus Other.
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of grants) {
      const k = categoryOf.get(g.id) ?? OTHER_CATEGORY.key;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...categoriesFor(clientId).map((c) => c.key), OTHER_CATEGORY.key]
      .filter((k) => (counts.get(k) ?? 0) > 0)
      .map((k) => ({ key: k, label: categoryLabel(clientId, k), n: counts.get(k)! }));
  }, [grants, categoryOf]);

  async function patchGrant(id: string, payload: Record<string, unknown>) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/grants/${clientId}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as { opportunity?: FpOpportunity; error?: string } | null;
      if (!res.ok || !data?.opportunity) {
        setError(data?.error ?? `request failed (${res.status})`);
        return;
      }
      const opp = data.opportunity;
      setGrants((prev) => prev.map((g) => (g.id === opp.id ? opp : g)));
      setPassingId(null);
      setPassReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const months = useMemo(() => {
    const byMonth = new Map<string, FpOpportunity[]>();
    for (const g of sorted) {
      const key = g.responseDeadline ? g.responseDeadline.slice(0, 7) : "none";
      const list = byMonth.get(key) ?? [];
      list.push(g);
      byMonth.set(key, list);
    }
    return [...byMonth.entries()].sort(([a], [b]) =>
      a === "none" ? 1 : b === "none" ? -1 : a.localeCompare(b),
    );
  }, [sorted]);

  const openCount = grants.filter(
    (g) => !["triaged_nobid", "closed_won", "closed_lost", "closed_no_award", "withdrawn"].includes(g.status),
  ).length;

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "review", label: `Review queue${reviewQueue.length > 0 ? ` (${reviewQueue.length})` : ""}` },
    { key: "all", label: "All grants" },
    { key: "timeline", label: "Timeline" },
    { key: "reopen", label: `Reopen watch${reopenList.length > 0 ? ` (${reopenList.length})` : ""}` },
  ];

  // Small shared bits for category display and the reopen-watch action.
  const categoryBadge = (g: FpOpportunity) => (
    <span className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px] font-medium text-stone-600">
      {categoryLabel(clientId, categoryOf.get(g.id) ?? OTHER_CATEGORY.key)}
    </span>
  );
  const deadlinePassed = (g: FpOpportunity) => {
    const d = daysUntil(g.responseDeadline);
    return d != null && d < 0;
  };
  const reopenWatchButton = (g: FpOpportunity) =>
    g.reopenWatchAt == null ? (
      <button
        disabled={busyId === g.id}
        onClick={() => patchGrant(g.id, { reopenWatch: true })}
        title="This cycle closed — have the daily watch re-search this program and flag it when the next cycle opens"
        className="rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-40"
      >
        Remind when reopens
      </button>
    ) : (
      <button
        disabled={busyId === g.id}
        onClick={() => patchGrant(g.id, { reopenWatch: false })}
        title={`Watching for the next cycle since ${new Date(g.reopenWatchAt).toLocaleDateString()} — click to stop`}
        className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:opacity-40"
      >
        Watching for reopen ✓
      </button>
    );

  return (
    <div className={T.pageBg}>
      {/* Standalone header — deliberately not AppHeader/gs-chrome. */}
      <header className={T.headerBg}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-3">
          <div>
            <div className={T.orgCls}>{T.orgLine}</div>
            <h1 className="mt-0.5 text-xl font-semibold">Grants Workspace</h1>
            <p className={T.subtitleCls}>{T.subtitle}</p>
          </div>
          <div className={T.statsCls}>
            <div>
              {grants.length} tracked · {openCount} open · {reviewQueue.length} awaiting go/no-go
            </div>
            <div className={T.userCls}>{user.name}</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-5">
        {/* The workspace's own watchers — OpenClaw owns the schedule, this is
            a read-only observation strip (same source as /cron-health). */}
        {crons.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className={T.kicker}>Watching for {T.watchLabel}</span>
            {crons.map((c) => (
              <span
                key={c.id}
                title={`${c.scheduleExpr ?? ""} ${c.tz ?? ""} — status: ${c.status}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  c.status === "ok" || c.status === "disabled"
                    ? T.cronPillOk
                    : c.status === "stale" || c.status === "blocked"
                      ? "border-amber-300 bg-amber-50 text-amber-800"
                      : "border-rose-300 bg-rose-50 text-rose-700"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    c.status === "ok" ? "bg-emerald-500" : c.lastRunAtMs == null ? "bg-stone-300" : "bg-rose-500"
                  }`}
                />
                {c.name.replace(new RegExp(`^${T.watchLabel}\\s*`, "i"), "")}
                <span className={T.cronMeta}>· {cadenceLabel(c.scheduleExpr)}</span>
              </span>
            ))}
          </div>
        )}

        <nav className="flex gap-2">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                tab === key ? T.tabOn : T.tabOff
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Program-category filter — applies to every tab. */}
        {categoryCounts.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setCategoryFilter(null)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                categoryFilter == null ? T.tabOn : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
              }`}
            >
              All programs ({grants.length})
            </button>
            {categoryCounts.map((c) => (
              <button
                key={c.key}
                onClick={() => setCategoryFilter(categoryFilter === c.key ? null : c.key)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
                  categoryFilter === c.key ? T.tabOn : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
                }`}
              >
                {c.label} ({c.n})
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {tab === "review" && (
          <section className="mt-4">
            {reviewQueue.length === 0 ? (
              <div className={`${T.card} p-8 text-center text-sm text-stone-500`}>
                Review queue is clear — every discovered grant has a go/no-go decision. New finds from
                the scheduled watches will appear here.
              </div>
            ) : (
              <ul className="space-y-3">
                {reviewQueue.map((g) => (
                  <li key={g.id} className={`${T.card} p-4 shadow-sm`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${LEVEL_CLS[levelOf(g.source)]}`}>
                            {levelOf(g.source)}
                          </span>
                          {categoryBadge(g)}
                          <PaBadge description={g.description} />
                          <DeadlineBadge deadline={g.responseDeadline} />
                        </div>
                        <h3 className="mt-1.5 font-semibold text-stone-900">
                          {g.url ? (
                            <a href={g.url} target="_blank" rel="noreferrer" className="hover:underline">
                              {g.title}
                            </a>
                          ) : (
                            g.title
                          )}
                        </h3>
                        <div className="text-xs text-stone-500">{g.agency ?? "Funder not recorded"}</div>
                        {g.description && (
                          <p className="mt-1.5 max-w-3xl text-sm text-stone-600">{g.description}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        {passingId === g.id ? (
                          <div className="flex flex-col items-end gap-1.5">
                            <input
                              autoFocus
                              value={passReason}
                              onChange={(e) => setPassReason(e.target.value)}
                              placeholder="Why pass? (required)"
                              className="w-64 rounded-md border border-stone-300 px-2 py-1 text-sm"
                            />
                            <div className="flex gap-1.5">
                              <button
                                disabled={busyId === g.id || !passReason.trim()}
                                onClick={() => patchGrant(g.id, { status: "triaged_nobid", reason: passReason.trim() })}
                                className="rounded-md bg-stone-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
                              >
                                Confirm pass
                              </button>
                              <button
                                onClick={() => {
                                  setPassingId(null);
                                  setPassReason("");
                                }}
                                className="rounded-md border border-stone-300 px-3 py-1 text-xs"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button
                              disabled={busyId === g.id}
                              onClick={() => patchGrant(g.id, { status: "triaged_bid" })}
                              className={T.pursueBtn}
                            >
                              Pursue
                            </button>
                            <button
                              disabled={busyId === g.id}
                              onClick={() => setPassingId(g.id)}
                              className="rounded-md border border-stone-300 bg-white px-4 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-50 disabled:opacity-40"
                            >
                              Pass
                            </button>
                            {/* A passed deadline changes the decision: the
                                cycle is closed, so the useful call is "watch
                                for the next one", not bid/no-bid. */}
                            {deadlinePassed(g) && reopenWatchButton(g)}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {tab === "all" &&
          // Split by program category (WIC/nutrition, LIHEAP, Head Start, ...)
          // — one table per category, deadline-sorted within each.
          (() => {
            const groups: Array<{ key: string; label: string; list: FpOpportunity[] }> = [
              ...categoriesFor(clientId).map((c) => ({ key: c.key, label: c.label, list: [] as FpOpportunity[] })),
              { key: OTHER_CATEGORY.key, label: OTHER_CATEGORY.label, list: [] as FpOpportunity[] },
            ];
            for (const g of sorted) {
              const k = categoryOf.get(g.id) ?? OTHER_CATEGORY.key;
              groups.find((gr) => gr.key === k)!.list.push(g);
            }
            return (
              <section className="mt-4 space-y-5">
                {groups
                  .filter((gr) => gr.list.length > 0)
                  .map((gr) => (
                    <div key={gr.key} className={`overflow-hidden ${T.card} shadow-sm`}>
                      <div className={`flex items-center justify-between px-4 py-2.5 ${T.theadCls} border-b-0`}>
                        <span className="text-xs font-bold normal-case tracking-normal">{gr.label}</span>
                        <span className="font-normal">{gr.list.length} grant{gr.list.length === 1 ? "" : "s"}</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <tbody className="divide-y divide-stone-100 border-t border-stone-100">
                            {gr.list.map((g) => {
                              const status = STATUS_LABELS[g.status];
                              const amount = extractAmount(g.description);
                              return (
                                <tr key={g.id} className="align-top">
                                  <td className="max-w-[22rem] px-4 py-3 font-medium text-stone-900">
                                    {g.url ? (
                                      <a href={g.url} target="_blank" rel="noreferrer" className="hover:underline">
                                        {g.title}
                                      </a>
                                    ) : (
                                      g.title
                                    )}
                                    <div className="mt-0.5 text-[11px] font-normal text-stone-400">
                                      {g.agency ?? ""}
                                      {g.solNumber ? <span className="ml-1 font-mono">{g.solNumber}</span> : null}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3">
                                    <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${LEVEL_CLS[levelOf(g.source)]}`}>
                                      {levelOf(g.source)}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3">
                                    <DeadlineBadge deadline={g.responseDeadline} />
                                  </td>
                                  <td className={T.amountCls}>
                                    {amount ?? <span className="font-normal text-stone-400">—</span>}
                                  </td>
                                  <td className="max-w-[24rem] px-4 py-3 text-xs text-stone-600">
                                    <div className="mb-1">
                                      <PaBadge description={g.description} />
                                    </div>
                                    {g.description ?? <span className="italic text-stone-400">no summary from scan</span>}
                                    {g.status === "triaged_nobid" && g.nobidReason && (
                                      <div className="mt-1 text-[11px] text-stone-400">Passed: {g.nobidReason}</div>
                                    )}
                                  </td>
                                  <td className="px-4 py-3">
                                    <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold ${status.cls}`}>
                                      {status.label}
                                    </span>
                                    {g.reopenWatchAt != null && (
                                      <div className="mt-1">
                                        <span className="inline-block whitespace-nowrap rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                                          Reopen watch
                                        </span>
                                      </div>
                                    )}
                                    {deadlinePassed(g) && g.reopenWatchAt == null && g.status === "discovered" && (
                                      <div className="mt-1.5">{reopenWatchButton(g)}</div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}
              </section>
            );
          })()}

        {tab === "reopen" && (
          <section className="mt-4">
            {reopenList.length === 0 ? (
              <div className={`${T.card} p-8 text-center text-sm text-stone-500`}>
                Nothing on reopen watch. When a grant&apos;s deadline has passed, use{" "}
                <em>Remind when reopens</em> to have the scheduled watches re-search that program and
                flag its next cycle.
              </div>
            ) : (
              <ul className="space-y-3">
                {reopenList.map((g) => (
                  <li key={g.id} className={`${T.card} p-4 shadow-sm`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${LEVEL_CLS[levelOf(g.source)]}`}>
                            {levelOf(g.source)}
                          </span>
                          {categoryBadge(g)}
                          <PaBadge description={g.description} />
                          <DeadlineBadge deadline={g.responseDeadline} />
                        </div>
                        <h3 className="mt-1.5 font-semibold text-stone-900">
                          {g.url ? (
                            <a href={g.url} target="_blank" rel="noreferrer" className="hover:underline">
                              {g.title}
                            </a>
                          ) : (
                            g.title
                          )}
                        </h3>
                        <div className="text-xs text-stone-500">{g.agency ?? "Funder not recorded"}</div>
                        {g.description && (
                          <p className="mt-1.5 max-w-3xl text-sm text-stone-600">{g.description}</p>
                        )}
                        {g.reopenWatchAt != null && (
                          <p className="mt-1 text-[11px] text-sky-700">
                            Watching since {new Date(g.reopenWatchAt).toLocaleDateString()} — the daily
                            watch re-searches this program each run and will flag the next cycle.
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">{reopenWatchButton(g)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {tab === "timeline" && (
          <section className="mt-4 space-y-5">
            {months.map(([month, list]) => (
              <div key={month}>
                <h2 className={T.monthCls}>
                  {month === "none"
                    ? "No deadline posted"
                    : new Date(`${month}-15T12:00:00`).toLocaleDateString(undefined, {
                        month: "long",
                        year: "numeric",
                      })}
                </h2>
                <ul className={T.timelineBorder}>
                  {list.map((g) => {
                    const status = STATUS_LABELS[g.status];
                    return (
                      <li key={g.id} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-sm font-medium text-stone-900">
                              {g.url ? (
                                <a href={g.url} target="_blank" rel="noreferrer" className="hover:underline">
                                  {g.title}
                                </a>
                              ) : (
                                g.title
                              )}
                            </span>
                            <span className="ml-2 text-xs text-stone-500">{g.agency ?? ""}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <DeadlineBadge deadline={g.responseDeadline} />
                            <span className={`inline-block whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>
                              {status.label}
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}

        <p className="mt-6 text-[11px] text-stone-400">{T.footer}</p>
      </main>
    </div>
  );
}
