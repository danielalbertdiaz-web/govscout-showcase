import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import {
  usageTotals,
  usageByStage,
  usageByModel,
  usageByOpportunity,
  listRecentUsageEvents,
  type UsageRollup,
} from "@/lib/usage";
import { AppHeader } from "@/app/_components/AppHeader";

export const dynamic = "force-dynamic";

// Item 3.2 — the usage surface. Visibility ONLY: where the model spend went,
// broken down by pipeline stage, model, and opportunity. By design there are no
// caps, budgets, or expected-value math here — just an honest ledger.

function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default async function UsagePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const totals = usageTotals();
  const byStage = usageByStage();
  const byModel = usageByModel();
  const byOpp = usageByOpportunity(25);
  const recent = listRecentUsageEvents(50);

  const maxStageCost = Math.max(0.0001, ...byStage.map((r) => r.costUsd));

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="Spend ledger"
        title="Usage"
        subtitle="Where model spend went — visibility only, no caps"
        userLabel={session.name ?? session.email}
        activeNav="usage"
        leadingActions={
          <Link
            href="/learning"
            className="rounded-md border border-stone-400 bg-white/80 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            ← Learning
          </Link>
        }
      />

      {/* Totals band */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total cost" value={fmtUsd(totals.costUsd)} tone="emerald" />
        <Stat label="Invocations" value={String(totals.events)} />
        <Stat label="Input tokens" value={fmtTokens(totals.inputTokens)} />
        <Stat label="Output tokens" value={fmtTokens(totals.outputTokens)} />
      </section>

      {totals.events === 0 && (
        <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-center text-xs text-stone-500">
          No usage recorded yet. Run a council, synthesize a section, or score a
          scout/NOFO and its token spend will appear here.
        </p>
      )}

      {/* By stage — bar curve */}
      {byStage.length > 0 && (
        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
            By stage
          </h2>
          <p className="mt-1 text-xs text-stone-500">
            Which part of the pipeline the spend served (scoring, council, synthesize…).
          </p>
          <div className="mt-4 space-y-2">
            {byStage.map((r) => {
              const widthPct = Math.round((r.costUsd / maxStageCost) * 100);
              return (
                <div key={r.key ?? "uncategorized"} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 truncate text-right font-mono text-[11px] text-stone-500">
                    {r.key ?? "uncategorized"}
                  </span>
                  <div className="relative h-6 flex-1 overflow-hidden rounded bg-stone-100">
                    <div
                      className="h-full rounded bg-emerald-500/80"
                      style={{ width: `${widthPct}%` }}
                    />
                    <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold text-stone-700">
                      {fmtUsd(r.costUsd)}
                    </span>
                  </div>
                  <span className="w-20 shrink-0 text-[11px] text-stone-400">
                    {r.events} call{r.events === 1 ? "" : "s"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* By model */}
      {byModel.length > 0 && (
        <RollupTable
          title="By model"
          subtitle="Spend per model family. Cache reads bill at ~0.1× input."
          keyHeader="Model"
          rows={byModel}
        />
      )}

      {/* By opportunity */}
      {byOpp.length > 0 && (
        <RollupTable
          title="By opportunity"
          subtitle="Draft-attributed spend, rolled up to the opportunity it served."
          keyHeader="Opportunity"
          rows={byOpp}
          linkOpp
        />
      )}

      {/* Recent events */}
      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
          Recent invocations ({recent.length})
        </h2>
        {recent.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-center text-xs text-stone-500">
            No invocations recorded yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-stone-400">
                  <th className="py-1 pr-3 font-semibold">When</th>
                  <th className="py-1 pr-3 font-semibold">Stage</th>
                  <th className="py-1 pr-3 font-semibold">Model</th>
                  <th className="py-1 pr-3 text-right font-semibold">In</th>
                  <th className="py-1 pr-3 text-right font-semibold">Out</th>
                  <th className="py-1 text-right font-semibold">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {recent.map((e) => (
                  <tr key={e.id} className="text-stone-700">
                    <td className="py-1.5 pr-3 text-stone-400">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[11px]">{e.stage}</td>
                    <td className="py-1.5 pr-3 font-mono text-[11px] text-stone-500">
                      {e.model.replace(/^claude-/, "")}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {fmtTokens(e.inputTokens)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {fmtTokens(e.outputTokens)}
                    </td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">
                      {fmtUsd(e.costUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function RollupTable({
  title,
  subtitle,
  keyHeader,
  rows,
  linkOpp,
}: {
  title: string;
  subtitle: string;
  keyHeader: string;
  rows: UsageRollup[];
  linkOpp?: boolean;
}) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">{title}</h2>
      <p className="mt-1 text-xs text-stone-500">{subtitle}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-stone-400">
              <th className="py-1 pr-3 font-semibold">{keyHeader}</th>
              <th className="py-1 pr-3 text-right font-semibold">Calls</th>
              <th className="py-1 pr-3 text-right font-semibold">In</th>
              <th className="py-1 pr-3 text-right font-semibold">Out</th>
              <th className="py-1 text-right font-semibold">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((r) => {
              const label = r.key ?? "—";
              return (
                <tr key={label} className="text-stone-700">
                  <td className="py-1.5 pr-3 font-mono text-[11px]">
                    {linkOpp && r.key ? (
                      <Link
                        href={`/opportunities/${r.key}`}
                        className="text-emerald-700 hover:underline"
                      >
                        {label.slice(0, 12)}
                      </Link>
                    ) : (
                      label.replace(/^claude-/, "")
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.events}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtTokens(r.inputTokens)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtTokens(r.outputTokens)}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums">{fmtUsd(r.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald";
}) {
  const valueClass = tone === "emerald" ? "text-emerald-700" : "text-stone-900";
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}
