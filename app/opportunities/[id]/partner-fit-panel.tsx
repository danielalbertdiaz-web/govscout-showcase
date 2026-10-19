"use client";

// Item 4.2 — partner-fit panel on the opportunity page. Fetches the ranking,
// shows fit score + reasons/risks per partner, the team/solo/pass call, and a
// per-partner "Generate intro draft" button. The intro is SAVED AS A DRAFT —
// nothing is ever sent. Only renders meaningful content when the opportunity
// clears the score gate (≥60/100); below that it shows a quiet note.

import { useEffect, useState } from "react";

type Fit = {
  id: string;
  name: string;
  type: string;
  fitScore: number;
  reasons: string[];
  risks: string[];
};

type Ranking = {
  ranked: Fit[];
  best: Fit | null;
  recommendation: "team" | "solo" | "pass";
  recommendationReason: string;
};

type GetResp = {
  eligible: boolean;
  scoreGate: number;
  strategicScore: number | null;
  ranking: Ranking;
};

type IntroResp = {
  saved: boolean;
  sent: boolean;
  path: string;
  markdown: string;
  redactions: { rule: string; matched: string }[];
  safe: boolean;
};

const REC_STYLE: Record<Ranking["recommendation"], string> = {
  team: "bg-emerald-100 text-emerald-900 border-emerald-300",
  solo: "bg-amber-100 text-amber-900 border-amber-300",
  pass: "bg-stone-200 text-stone-700 border-stone-300",
};

function scoreColor(s: number): string {
  if (s >= 60) return "text-emerald-700";
  if (s >= 40) return "text-amber-700";
  return "text-stone-500";
}

export default function PartnerFitPanel({ opportunityId }: { opportunityId: string }) {
  const [data, setData] = useState<GetResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [intro, setIntro] = useState<(IntroResp & { partnerId: string }) | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/opportunities/${opportunityId}/partner-fit`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as GetResp;
        if (alive) setData(json);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [opportunityId]);

  async function generateIntro(partnerId: string) {
    setBusy(partnerId);
    setIntro(null);
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/partner-fit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partnerId }),
      });
      const json = (await res.json()) as IntroResp;
      if (!res.ok) throw new Error((json as unknown as { error?: string }).error ?? "failed");
      setIntro({ ...json, partnerId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to draft intro");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-stone-200 bg-white p-5 text-sm text-stone-500 shadow-sm">
        Loading partner fit…
      </section>
    );
  }
  if (error && !data) {
    return (
      <section className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700 shadow-sm">
        Partner fit unavailable: {error}
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
          Partner fit
        </h2>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${REC_STYLE[data.ranking.recommendation]}`}
        >
          {data.ranking.recommendation.toUpperCase()}
        </span>
      </div>
      <p className="mt-1 text-xs text-stone-500">{data.ranking.recommendationReason}</p>

      {!data.eligible && (
        <p className="mt-3 rounded-md bg-stone-50 p-2 text-xs text-stone-500">
          This opportunity scores{" "}
          {data.strategicScore == null ? "unscored" : `${data.strategicScore}/100`} — below the{" "}
          {data.scoreGate}/100 gate where partner ranking is most reliable. Ranking shown for
          reference.
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-3">
        {data.ranking.ranked.map((f, i) => (
          <li
            key={f.id}
            className={`rounded-lg border p-3 ${i === 0 ? "border-emerald-200 bg-emerald-50/30" : "border-stone-200"}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-stone-800">{f.name}</span>
                <span className="text-[11px] uppercase tracking-wide text-stone-400">{f.type}</span>
                {i === 0 && (
                  <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                    Top
                  </span>
                )}
              </div>
              <span className={`text-lg font-bold tabular-nums ${scoreColor(f.fitScore)}`}>
                {f.fitScore}
                <span className="text-xs font-normal text-stone-400">/100</span>
              </span>
            </div>

            {f.reasons.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5">
                {f.reasons.map((r, j) => (
                  <li key={j} className="text-xs text-emerald-800">
                    ✓ {r}
                  </li>
                ))}
              </ul>
            )}
            {f.risks.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {f.risks.map((r, j) => (
                  <li key={j} className="text-xs text-amber-700">
                    ⚠ {r}
                  </li>
                ))}
              </ul>
            )}

            <button
              onClick={() => generateIntro(f.id)}
              disabled={busy === f.id}
              className="mt-2 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            >
              {busy === f.id ? "Drafting…" : "Generate intro draft"}
            </button>
          </li>
        ))}
        {data.ranking.ranked.length === 0 && (
          <li className="text-xs text-stone-500">No candidate partners to rank.</li>
        )}
      </ul>

      {intro && (
        <div className="mt-4 rounded-lg border border-stone-300 bg-stone-50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-stone-700">
              Draft intro — {intro.partnerId} ·{" "}
              <span className="font-normal text-stone-500">saved to {intro.path}</span>
            </span>
            <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-stone-600">
              Not sent
            </span>
          </div>
          {!intro.safe && intro.redactions.length > 0 && (
            <p className="mt-1 text-[11px] text-rose-600">
              {intro.redactions.length} internal phrase(s) auto-redacted before saving.
            </p>
          )}
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-[11px] leading-5 text-stone-800">
            {intro.markdown}
          </pre>
        </div>
      )}
    </section>
  );
}
