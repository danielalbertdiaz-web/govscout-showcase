import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";
import { loadCronHealth, type CronHealth, type CronStatus } from "@/lib/cron-health";
import { formatInTz } from "@/lib/dateService";
import { AlfredChatPanel, ChatAboutJobButton } from "./AlfredChatPanel";
import { DeleteCronButton } from "./DeleteCronButton";

// Item 1.3: the cron-health dashboard. Reads ~/.openclaw/cron state fresh on
// every request — a stale render would defeat the purpose — so force-dynamic.
export const dynamic = "force-dynamic";

// Status → badge styling + label. Order here also drives the summary counts.
const STATUS_STYLES: Record<CronStatus, { label: string; cls: string }> = {
  failed: { label: "Failed", cls: "border-red-300 bg-red-50 text-red-700" },
  // Disabled while failing — not a deliberate off, a lane that went dark.
  abandoned: { label: "Abandoned", cls: "border-purple-300 bg-purple-50 text-purple-700" },
  blocked: { label: "Blocked", cls: "border-amber-300 bg-amber-50 text-amber-800" },
  stale: { label: "Stale", cls: "border-orange-300 bg-orange-50 text-orange-700" },
  disabled: { label: "Disabled", cls: "border-stone-300 bg-stone-100 text-stone-500" },
  ok: { label: "OK", cls: "border-emerald-300 bg-emerald-50 text-emerald-700" },
};

const STATUS_ORDER: CronStatus[] = ["failed", "abandoned", "blocked", "stale", "disabled", "ok"];

// Owner-type grouping (the operator, 2026-08-26): the fleet serves five different
// masters and a flat list hides which one is broken. First match wins;
// anything unmatched lands in Acme Consulting LAST — most of the fleet is Acme
// work, so it is the honest default, and a new client's jobs should get a
// rule here rather than silently swelling Acme's section.
const CRON_GROUPS: Array<{ label: string; pattern: RegExp | null }> = [
  { label: "Riverside", pattern: /riverside/i },
  { label: "Northstar Training Institute", pattern: /northstar/i },
  { label: "Job Hunt", pattern: /resume|job.?hunt|linkedin|interview|application/i },
  {
    label: "Personal",
    pattern: /newsletter|concept factory|bible|personal|system update|behavioral health/i,
  },
  { label: "Acme Consulting", pattern: null }, // fallback
];

function cronGroupLabel(name: string): string {
  for (const g of CRON_GROUPS) {
    if (g.pattern?.test(name)) return g.label;
  }
  return "Acme Consulting";
}

function fmtTs(ms: number | null): string {
  if (ms == null) return "—";
  return formatInTz(ms, undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Compact human age: "3d 4h", "5h 12m", "8m", or "<1m".
function fmtAge(ms: number | null): string {
  if (ms == null) return "—";
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default async function CronHealthPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const crons: CronHealth[] = loadCronHealth();
  const sorted = [...crons].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  const counts = STATUS_ORDER.map((s) => ({
    status: s,
    n: crons.filter((c) => c.status === s).length,
  })).filter((c) => c.n > 0);

  const attention = crons.filter(
    (c) =>
      c.status === "failed" || c.status === "abandoned" || c.status === "blocked" || c.status === "stale",
  ).length;

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Operations"
        title="Cron health"
        subtitle="Daily scans, watchers & digests — last run, status, and silence detection"
        userLabel={session.name ?? session.email}
      />

      <div className="mt-4">
        <PageInfo id="cron-health" title="How are the scans scheduled?">
          <p>
            <strong>Not via Alfred</strong> — Alfred can trigger scans on request, but the standing schedule lives in two
            places: a <strong>daily 7am launchd job</strong> on this Mac runs every scanner
            (<code>scripts/run-all-scans.mts</code> — install via <code>ops/com.govscout.scans.plist</code>), and the{" "}
            <em>Run all scans</em> button on <strong>Scouts</strong> fires the same rail on demand.
          </p>
          <p>
            To change the cadence, edit the Hour/Minute in the plist and reload it. (The <code>vercel.json</code> schedules
            only apply if the app is ever hosted on Vercel — they do nothing on this machine.) This page is the watchdog:
            if a lane goes quiet past its expected interval, it shows red here.
          </p>
        </PageInfo>
      </div>

      {/* Summary strip */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {counts.length === 0 ? (
          <span className="text-sm text-stone-500 italic">No crons registered.</span>
        ) : (
          counts.map(({ status, n }) => (
            <span
              key={status}
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${STATUS_STYLES[status].cls}`}
            >
              {n} {STATUS_STYLES[status].label}
            </span>
          ))
        )}
        {attention === 0 && crons.length > 0 && (
          <span className="text-xs text-stone-500">All clear — every cron is healthy.</span>
        )}
      </div>

      {sorted.length === 0 && (
        <div className="mt-4 rounded-xl border border-stone-200 bg-white p-6 text-center text-sm italic text-stone-500">
          No crons found in ~/.openclaw/cron. The external runner may not be configured on this
          host.
        </div>
      )}

      {["Acme Consulting", "Personal", "Job Hunt", "Riverside", "Northstar Training Institute"]
        .map((label) => ({ label, rows: sorted.filter((c) => cronGroupLabel(c.name) === label) }))
        .filter((g) => g.rows.length > 0)
        .map((g) => (
      <div key={g.label} className="mt-4 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-stone-200 bg-stone-100 px-4 py-2">
          <span className="text-xs font-bold uppercase tracking-wider text-stone-600">{g.label}</span>
          <span className="text-[11px] text-stone-400">
            {g.rows.length} job{g.rows.length === 1 ? "" : "s"}
            {(() => {
              const bad = g.rows.filter((c) => c.status !== "ok" && c.status !== "disabled").length;
              return bad > 0 ? ` · ${bad} need attention` : " · all healthy";
            })()}
          </span>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wider text-stone-500">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Cron</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">Last run</th>
              <th className="px-4 py-2.5 font-semibold">Last success</th>
              <th className="px-4 py-2.5 font-semibold">Since success</th>
              <th className="px-4 py-2.5 font-semibold">Last failure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {g.rows.map((c) => {
                const style = STATUS_STYLES[c.status];
                return (
                  <tr key={c.id} className="align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium text-stone-900">{c.name}</div>
                      <div className="text-[11px] text-stone-400">
                        {c.scheduleExpr ? (
                          <span className="font-mono">{c.scheduleExpr}</span>
                        ) : (
                          "no schedule"
                        )}
                        {c.tz ? ` · ${c.tz}` : ""}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <ChatAboutJobButton jobName={c.name} jobId={c.id} />
                        <DeleteCronButton jobId={c.id} jobName={c.name} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${style.cls}`}
                      >
                        {style.label}
                      </span>
                      <div className="mt-1 max-w-[18rem] text-[11px] text-stone-500">
                        {c.reason}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-600">{fmtTs(c.lastRunAtMs)}</td>
                    <td className="px-4 py-3 text-xs text-stone-600">{fmtTs(c.lastSuccessMs)}</td>
                    <td className="px-4 py-3 text-xs text-stone-600">
                      {fmtAge(c.sinceLastSuccessMs)}
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-600">
                      {fmtTs(c.lastFailureMs)}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
        ))}

      <p className="mt-3 text-[11px] text-stone-400">
        Source: <span className="font-mono">~/.openclaw/cron</span> (jobs.json,
        jobs-state.json, runs/*.jsonl). Read-only — the external runner owns scheduling,
        the once-per-stale-window alert, and scan-fail protection.
      </p>

      {/* Bridge into the configured OpenClaw assistant session. */}
      <AlfredChatPanel />
    </div>
  );
}
