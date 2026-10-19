import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { listOpportunityDispositions, listDispositionScoreSamples } from "@/lib/db";
import {
  computeCalibration,
  summarizeDispositions,
  DISPOSITION_LABELS,
  type Disposition,
} from "@/lib/disposition";
import { AppHeader } from "@/app/_components/AppHeader";

export const dynamic = "force-dynamic";

// Item 3.1 — the learning surface. Two views of the win/loss record:
// (1) the calibration curve (strategic-score band vs. actual decided win rate),
// which answers "are our scores honest?", and (2) the raw disposition log that
// feeds the council's feedback loop.

export default async function LearningPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const history = listOpportunityDispositions(session.email);
  const samples = listDispositionScoreSamples(session.email);
  const bands = computeCalibration(samples, { min: 0, max: 100, bands: 5 });
  const summary = summarizeDispositions(history);

  const maxWinRate = Math.max(
    0.0001,
    ...bands.map((b) => (b.winRate == null ? 0 : b.winRate)),
  );

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="Feedback loop"
        title="Learning"
        subtitle="How our scoring compares to what actually won"
        userLabel={session.name ?? session.email}
        activeNav="learning"
        leadingActions={
          <Link
            href="/opportunities"
            className="rounded-md border border-stone-400 bg-white/80 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            ← Opportunities
          </Link>
        }
      />

      {/* Summary band */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Disposed" value={String(summary.total)} />
        <Stat label="Won" value={String(summary.won)} tone="emerald" />
        <Stat label="Lost" value={String(summary.lost)} tone="rose" />
        <Stat
          label="Decided win rate"
          value={summary.decidedWinRate == null ? "—" : `${Math.round(summary.decidedWinRate * 100)}%`}
        />
      </section>

      {/* Calibration curve */}
      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
          Calibration curve
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          For each strategic-score band, the actual decided win rate (won ÷ submitted).
          A well-calibrated scorer trends upward left-to-right. Bands with no decided
          outcomes yet are shown empty.
        </p>

        {samples.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-center text-xs text-stone-500">
            No scored-and-decided opportunities yet. Set an outcome on a saved
            opportunity (after it&apos;s been strategically scored) and it will appear
            here.
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {bands
              .slice()
              .reverse()
              .map((b) => {
                const pct = b.winRate == null ? null : Math.round(b.winRate * 100);
                const widthPct =
                  b.winRate == null ? 0 : Math.round((b.winRate / maxWinRate) * 100);
                return (
                  <div key={b.label} className="flex items-center gap-3">
                    <span className="w-16 shrink-0 text-right font-mono text-[11px] text-stone-500">
                      {b.label}
                    </span>
                    <div className="relative h-6 flex-1 overflow-hidden rounded bg-stone-100">
                      <div
                        className="h-full rounded bg-emerald-500/80"
                        style={{ width: `${widthPct}%` }}
                      />
                      <span className="absolute inset-y-0 left-2 flex items-center text-[11px] font-semibold text-stone-700">
                        {pct == null ? "no decided outcomes" : `${pct}%`}
                      </span>
                    </div>
                    <span className="w-24 shrink-0 text-[11px] text-stone-400">
                      {b.decided}/{b.sampleSize} decided
                    </span>
                  </div>
                );
              })}
          </div>
        )}
      </section>

      {/* Raw disposition log */}
      <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
          Outcome log ({history.length})
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          These records are fed to every council agent — ranked by similarity to the
          opportunity under review — so scoring is grounded in real outcomes.
        </p>
        {history.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-center text-xs text-stone-500">
            No outcomes recorded yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100">
            {history.map((r) => (
              <li key={r.opportunityId} className="flex items-start gap-3 py-2">
                <DispositionTag disposition={r.disposition} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/opportunities/${r.opportunityId}`}
                    className="block truncate text-sm font-medium text-stone-800 hover:text-emerald-700 hover:underline"
                  >
                    {r.title}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-stone-400">
                    {r.dims.funder && <span>funder: {r.dims.funder}</span>}
                    {r.dims.mechanism && <span>NAICS: {r.dims.mechanism}</span>}
                    {r.dims.dollarBand && <span>size: {r.dims.dollarBand}</span>}
                    {r.at ? <span>{new Date(r.at).toLocaleDateString()}</span> : null}
                  </div>
                  {r.note && <p className="mt-1 text-xs italic text-stone-600">“{r.note}”</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "rose";
}) {
  const valueClass =
    tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : "text-stone-900";
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}

function DispositionTag({ disposition }: { disposition: Disposition }) {
  const tone: Record<Disposition, string> = {
    won: "border-emerald-300 bg-emerald-50 text-emerald-800",
    lost: "border-rose-300 bg-rose-50 text-rose-800",
    no_go: "border-stone-300 bg-stone-100 text-stone-700",
    passed_pre_draft: "border-amber-300 bg-amber-50 text-amber-800",
    expired_no_action: "border-stone-200 bg-stone-50 text-stone-500",
  };
  return (
    <span
      className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone[disposition]}`}
    >
      {DISPOSITION_LABELS[disposition]}
    </span>
  );
}
