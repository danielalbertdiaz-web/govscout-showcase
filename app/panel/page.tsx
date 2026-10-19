// Panel-Sim pane (minimal per spec §5): lists runs + aggregate cards for the
// latest complete run. Deliberately additive — no existing dashboard page is
// modified; this page is reached directly at /panel. Fresh runs start via the
// CLI (scripts/panel-sim.mts) or POST /api/panel-sim.

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppHeader } from "@/app/_components/AppHeader";
import { FUNNELS } from "@/lib/panel-sim";
import { getPanelReport, listPanelRuns } from "@/lib/panel-sim-store";

export const dynamic = "force-dynamic";

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export default async function PanelSimPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const runs = listPanelRuns(session.email, 50);
  const latest = runs.find((r) => r.status === "complete") ?? null;
  const report = latest ? getPanelReport(latest.id) : null;
  const stageLabel = (funnelKey: string, key: string) =>
    FUNNELS[funnelKey]?.find((f) => f.key === key)?.label ?? key;

  return (
    <div className="mx-auto max-w-5xl px-6 pt-3">
      <AppHeader
        tagline="Panel-Sim"
        title={`${runs.length} panel run${runs.length === 1 ? "" : "s"}`}
        subtitle="Reaction-panel / Monte Carlo war-gaming over artifacts. Advisory only — verdicts land in the Decision queue."
        userLabel={session.name ?? session.email}
      />

      {latest && report?.monteCarlo ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/60">
            Latest: {latest.label}
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            {report.monteCarlo.stages.map((s) => (
              <div key={s.stage} className="rounded-lg border border-white/10 bg-white/5 p-4">
                <div className="text-xs text-white/55">{stageLabel(latest.funnel, s.stage)}</div>
                <div className="mt-1 text-2xl font-semibold text-white">{pct(s.mean)}</div>
                <div className="mt-0.5 text-[11px] text-white/45">
                  95%: {pct(s.ci95[0])} – {pct(s.ci95[1])} · {report.monteCarlo!.iterations} iterations
                </div>
              </div>
            ))}
          </div>
          {report.aggregate?.riskFlags?.length ? (
            <div className="mt-4 rounded-lg border border-white/10 bg-white/5 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-white/60">
                Risk flags
              </div>
              <ul className="mt-2 space-y-1 text-sm text-white/80">
                {report.aggregate.riskFlags.slice(0, 6).map((r, i) => (
                  <li key={i}>
                    <span className="font-medium">{r.persona}</span> dies at{" "}
                    {stageLabel(latest.funnel, r.stage)} (p={pct(r.probability)})
                    {r.verbatim ? <span className="text-white/55"> — “{r.verbatim}”</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="mt-6 text-sm text-white/60">
          No completed runs yet. Seed or start one:{" "}
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">
            node --import tsx scripts/panel-sim.mts --help
          </code>
        </p>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/60">All runs</h2>
        <div className="mt-3 space-y-2">
          {runs.length === 0 ? (
            <p className="text-sm text-white/50">Nothing yet.</p>
          ) : (
            runs.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-white">{r.label}</div>
                  <div className="text-[11px] text-white/50">
                    {new Date(r.createdAt).toISOString().slice(0, 10)} · {r.backend} ·{" "}
                    {r.nPersonas} personas · funnel {r.funnel} · seed {r.seed}
                  </div>
                </div>
                <span
                  className={
                    "rounded-md border px-2 py-0.5 text-[11px] font-medium " +
                    (r.status === "complete"
                      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                      : r.status === "failed"
                        ? "border-red-400/30 bg-red-400/10 text-red-300"
                        : "border-amber-400/30 bg-amber-400/10 text-amber-300")
                  }
                >
                  {r.status}
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
