import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import {
  listRecentActivity,
  WATCHER_SOURCES,
  SEVERITIES,
  type ActivityEntry,
  type Severity,
} from "@/lib/activity";
import { AppHeader } from "@/app/_components/AppHeader";

export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, { icon: string; color: string }> = {
  scout_ingested: { icon: "⊕", color: "border-sky-300 bg-sky-50 text-sky-900" },
  scout_promoted: { icon: "↑", color: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  pool_status_changed: { icon: "↔", color: "border-amber-300 bg-amber-50 text-amber-900" },
  pool_created: { icon: "＋", color: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  draft_created: { icon: "＋", color: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  draft_saved: { icon: "✎", color: "border-stone-300 bg-stone-50 text-stone-700" },
  draft_status_changed: { icon: "↔", color: "border-amber-300 bg-amber-50 text-amber-900" },
  draft_version_saved: { icon: "🗂", color: "border-violet-300 bg-violet-50 text-violet-900" },
  partner_manifest_changed: { icon: "🤝", color: "border-violet-300 bg-violet-50 text-violet-900" },
  suggestion_created: { icon: "💡", color: "border-amber-300 bg-amber-50 text-amber-900" },
  suggestion_triaged: { icon: "✓", color: "border-sky-300 bg-sky-50 text-sky-900" },
  suggestion_completed: { icon: "✓", color: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  decision_created: { icon: "?", color: "border-rose-300 bg-rose-50 text-rose-900" },
  decision_resolved: { icon: "✓", color: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  boilerplate_updated: { icon: "📋", color: "border-violet-300 bg-violet-50 text-violet-900" },
  preflight_run: { icon: "🛡", color: "border-amber-300 bg-amber-50 text-amber-900" },
  alfred_tool_call: { icon: "🎩", color: "border-stone-400 bg-stone-100 text-stone-800" },
};

// S9 Track B: watcher source labels (icons + display names for filter chips).
const SOURCE_LABELS: Record<string, { icon: string; label: string }> = {
  federal_awards: { icon: "🏛", label: "Federal Awards" },
  county_procurement: { icon: "🏙", label: "County" },
  sam_gov: { icon: "📜", label: "SAM.gov" },
  usaspending: { icon: "💵", label: "USAspending" },
  behavioral_health: { icon: "🧠", label: "Behavioral Health" },
  foundations: { icon: "🎗", label: "Foundations" },
  manual: { icon: "✋", label: "Manual" },
};

const SEVERITY_LABELS: Record<Severity, { label: string; chip: string; row: string; badge: string }> = {
  info: {
    label: "Info",
    chip: "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100",
    row: "border-stone-200 bg-white",
    badge: "bg-sky-100 text-sky-800",
  },
  warn: {
    label: "Warn",
    chip: "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100",
    row: "border-amber-300 bg-amber-50/60",
    badge: "bg-amber-200 text-amber-900",
  },
  critical: {
    label: "Critical",
    chip: "border-rose-400 bg-rose-50 text-rose-900 hover:bg-rose-100",
    row: "border-rose-400 bg-rose-50",
    badge: "bg-rose-600 text-white",
  },
};

function labelFor(type: string): { icon: string; color: string } {
  return ACTION_LABELS[type] ?? { icon: "·", color: "border-stone-300 bg-stone-50 text-stone-700" };
}

function targetLink(targetType: string | null, targetId: string | null): string | null {
  if (!targetType || !targetId) return null;
  switch (targetType) {
    case "draft":
      return `/drafts/${targetId}`;
    case "pool":
      return `/pools/${targetId}`;
    case "scout":
      return `/scouts/${targetId}`;
    case "partner":
      return `/partners/${targetId}`;
    case "decision":
      return `/decisions/${targetId}`;
    default:
      return null;
  }
}

function fmt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function groupByDay(entries: ActivityEntry[]): Record<string, ActivityEntry[]> {
  const groups: Record<string, ActivityEntry[]> = {};
  for (const e of entries) {
    const key = new Date(e.createdAt).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  return groups;
}

// Normalize a query param into a string[] (Next gives us string | string[] | undefined).
function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
}

// Build a query-string with a single filter toggled. Used by chip <Link>s.
function toggleParam(
  current: URLSearchParams,
  key: string,
  value: string,
): string {
  const next = new URLSearchParams(current);
  const existing = next.getAll(key);
  if (existing.includes(value)) {
    next.delete(key);
    for (const v of existing) if (v !== value) next.append(key, v);
  } else {
    next.append(key, value);
  }
  const s = next.toString();
  return s ? `/activity?${s}` : "/activity";
}

function toggleFlag(current: URLSearchParams, key: string): string {
  const next = new URLSearchParams(current);
  if (next.get(key) === "1") next.delete(key);
  else next.set(key, "1");
  const s = next.toString();
  return s ? `/activity?${s}` : "/activity";
}

function rowChrome(e: ActivityEntry): string {
  if (e.severity && SEVERITY_LABELS[e.severity]) return SEVERITY_LABELS[e.severity].row;
  return "border-stone-200 bg-white";
}

function EventRow({ e, extraClass }: { e: ActivityEntry; extraClass?: string }) {
  const sourceMeta = e.source ? SOURCE_LABELS[e.source] : undefined;
  const legacyMeta = labelFor(e.actionType);
  const icon = sourceMeta?.icon ?? legacyMeta.icon;
  const sevMeta = e.severity ? SEVERITY_LABELS[e.severity] : null;
  const link = targetLink(e.targetType, e.targetId);

  return (
    <li className={`px-4 py-3 ${extraClass ?? ""}`}>
      <div className="flex items-start gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs ${
            sevMeta ? "border-stone-300 bg-white" : legacyMeta.color
          }`}
          title={e.actionType}
        >
          {icon}
        </span>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2 text-sm text-stone-800">
            {sevMeta && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${sevMeta.badge}`}
              >
                {e.severity}
              </span>
            )}
            {sourceMeta && (
              <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-stone-600">
                {sourceMeta.label}
              </span>
            )}
            {e.needsReview && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900">
                Needs review
              </span>
            )}
            {link ? (
              <Link href={link} className="hover:underline">
                {e.summary}
              </Link>
            ) : (
              <span>{e.summary}</span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-stone-500">
            <span className="font-mono">{e.actionType}</span> · {e.actor} · {fmt(e.createdAt)}
            {e.newItemsCount != null && <> · +{e.newItemsCount} new</>}
            {e.errorsCount != null && e.errorsCount > 0 && <> · {e.errorsCount} errors</>}
          </div>
          {e.detail && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-stone-500 hover:text-stone-700">
                Show details
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded border border-stone-200 bg-stone-50 p-2 text-[11px] text-stone-700">
                {JSON.stringify(e.detail, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{
    source?: string | string[];
    severity?: string | string[];
    needsReview?: string;
  }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const selectedSources = asList(sp.source);
  // Default to all severities if the user hasn't filtered yet (so they see everything).
  const selectedSeverities = asList(sp.severity);
  const needsReviewOnly = sp.needsReview === "1";

  const current = new URLSearchParams();
  for (const s of selectedSources) current.append("source", s);
  for (const s of selectedSeverities) current.append("severity", s);
  if (needsReviewOnly) current.set("needsReview", "1");

  const entries = listRecentActivity({
    sources: selectedSources.length > 0 ? selectedSources : undefined,
    severities: selectedSeverities.length > 0 ? selectedSeverities : undefined,
    needsReviewOnly,
  });

  // Pin critical events at the top so the eye lands on them first, regardless
  // of how recent the others are.
  const criticalEvents = entries.filter((e) => e.severity === "critical");
  const nonCriticalEvents = entries.filter((e) => e.severity !== "critical");
  const grouped = groupByDay(nonCriticalEvents);
  const dayKeys = Object.keys(grouped);

  return (
    <div className="mx-auto max-w-5xl px-6 pt-3">
      <AppHeader
        tagline="Activity"
        title={`${entries.length} event${entries.length === 1 ? "" : "s"} in the last 7 days`}
        subtitle="What changed across Scouts, Pools, Proposals, Partners, Alfred, and the daily watchers."
        userLabel={session.name ?? session.email}
        activeNav="activity"
      />

      <section className="mt-4 space-y-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
            Source
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {WATCHER_SOURCES.map((src) => {
              const meta = SOURCE_LABELS[src];
              const on = selectedSources.includes(src);
              return (
                <Link
                  key={src}
                  href={toggleParam(current, "source", src)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                    on
                      ? "border-stone-800 bg-stone-800 text-white"
                      : "border-stone-300 bg-white text-stone-700 hover:border-stone-400"
                  }`}
                >
                  <span className="mr-1">{meta.icon}</span>
                  {meta.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
            Severity
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {SEVERITIES.map((sev) => {
              const meta = SEVERITY_LABELS[sev];
              const on = selectedSeverities.includes(sev);
              return (
                <Link
                  key={sev}
                  href={toggleParam(current, "severity", sev)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                    on ? `${meta.chip} ring-2 ring-stone-800/30` : meta.chip
                  }`}
                >
                  {meta.label}
                </Link>
              );
            })}
            <Link
              href={toggleFlag(current, "needsReview")}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                needsReviewOnly
                  ? "border-amber-500 bg-amber-200 text-amber-900"
                  : "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
              }`}
            >
              {needsReviewOnly ? "✓ " : ""}Needs review
            </Link>
            {(selectedSources.length > 0 || selectedSeverities.length > 0 || needsReviewOnly) && (
              <Link
                href="/activity"
                className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-[11px] text-stone-600 hover:bg-stone-100"
              >
                Clear filters
              </Link>
            )}
          </div>
        </div>
      </section>

      <div className="mt-4 space-y-6">
        {entries.length === 0 && (
          <div className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-sm text-stone-500">
            No activity recorded yet. Save a draft, promote a scout, or change a pool status —
            it&apos;ll show up here.
          </div>
        )}

        {criticalEvents.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-rose-700">
              Critical · pinned
            </h2>
            <div className="overflow-hidden rounded-xl border-2 border-rose-400 bg-rose-50 shadow-sm">
              <ul className="divide-y divide-rose-200">
                {criticalEvents.map((e) => (
                  <EventRow key={e.id} e={e} extraClass={`font-bold ${rowChrome(e)}`} />
                ))}
              </ul>
            </div>
          </section>
        )}

        {dayKeys.map((day) => (
          <section key={day}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
              {day}
            </h2>
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
              <ul className="divide-y divide-stone-100">
                {grouped[day].map((e) => (
                  <EventRow key={e.id} e={e} extraClass={rowChrome(e)} />
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
