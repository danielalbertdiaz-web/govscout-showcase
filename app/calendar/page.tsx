import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import {
  listCalendarEvents,
  weekKey,
  weekLabel,
  type CalendarEvent,
  type CalendarKind,
} from "@/lib/calendar";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";

export const dynamic = "force-dynamic";

const KIND_BADGE: Record<CalendarKind, string> = {
  scout: "border-amber-400 bg-amber-100 text-amber-900",
  pool: "border-emerald-400 bg-emerald-100 text-emerald-900",
  nofo: "border-blue-400 bg-blue-100 text-blue-900",
  draft: "border-stone-400 bg-stone-100 text-stone-800",
  opportunity: "border-purple-400 bg-purple-100 text-purple-900",
};

const KIND_LABEL: Record<CalendarKind, string> = {
  scout: "Scout",
  pool: "Pool",
  nofo: "NOFO",
  draft: "Draft",
  opportunity: "Saved",
};

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function CalendarPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const events = listCalendarEvents(session.email);

  // Group by ISO week.
  const groups = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const k = weekKey(ev.dateMs);
    const arr = groups.get(k) ?? [];
    arr.push(ev);
    groups.set(k, arr);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "undated") return 1;
    if (b === "undated") return -1;
    return a.localeCompare(b);
  });

  const now = new Date().getTime();

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="Calendar · read-only"
        title={`${events.length} deadline${events.length === 1 ? "" : "s"} on file`}
        subtitle="Aggregated from Scouts, Pools, NOFOs, Saved opps, and Drafts."
        userLabel={session.name ?? session.email}
        activeNav="calendar"
      />

      <PageInfo id="calendar" title="Sync with Google Calendar">
        <p>
          Every deadline here is also published as a private <strong>iCal feed</strong> Google Calendar can subscribe to —
          new deadlines then appear on your phone automatically.
        </p>
        <p>
          <strong>Set up once:</strong> in Google Calendar → <em>Other calendars</em> → <em>+</em> →{" "}
          <em>From URL</em>, paste{" "}
          <code>
            {(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/calendar/ics?key={process.env.CALENDAR_FEED_KEY ?? "<set CALENDAR_FEED_KEY>"}
          </code>
          . Keep that URL private — the key is the password. (Google refreshes subscribed feeds every few hours.)
        </p>
      </PageInfo>

      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-stone-800">No deadlines surfaced yet.</p>
          <p className="mt-2 text-xs leading-5 text-stone-500">
            Add deadlines to{" "}
            <Link href="/pools" className="text-emerald-700 underline">
              Pools
            </Link>
            , upload NOFOs with key dates, save opportunities with a deadline, or score
            scouts.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {keys.map((k) => {
            const arr = groups.get(k) ?? [];
            const label = weekLabel(k);
            const isPast = k !== "undated" && Date.parse(k + "T00:00:00Z") + 7 * 86400000 < now;
            return (
              <section key={k}>
                <h2
                  className={`mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider ${
                    isPast ? "text-stone-400" : "text-stone-700"
                  }`}
                >
                  {label}
                  {isPast && <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] text-stone-600">past</span>}
                  <span className="text-stone-400">· {arr.length}</span>
                </h2>
                <ul className="space-y-2">
                  {arr.map((ev, i) => (
                    <li
                      key={`${ev.kind}-${ev.id}-${i}`}
                      className="rounded-lg border border-stone-200 bg-white px-3 py-2 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${KIND_BADGE[ev.kind]}`}
                            >
                              {KIND_LABEL[ev.kind]}
                            </span>
                            <Link
                              href={ev.detailHref}
                              className="truncate text-sm font-semibold text-emerald-800 hover:underline"
                            >
                              {ev.title}
                            </Link>
                          </div>
                          <p className="mt-0.5 text-xs text-stone-600">
                            {ev.dateMs != null ? fmtDate(ev.dateMs) : "Date TBD"}
                            <span className="ml-1 text-stone-400">· {ev.dateText}</span>
                            {ev.agency && (
                              <span className="ml-2 text-stone-500">· {ev.agency}</span>
                            )}
                          </p>
                        </div>
                        {ev.url && (
                          <a
                            href={ev.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-[11px] text-emerald-700 hover:underline"
                          >
                            Source ↗
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
