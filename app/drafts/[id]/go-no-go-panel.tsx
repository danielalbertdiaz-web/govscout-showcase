"use client";

// M3 — the GO / NO-GO panel: war-game a simulated review panel on this
// opportunity BEFORE committing 40–80 hours to the application. Hides itself
// when the simulation engine isn't configured. Verdicts are advisory and land
// in the Decision queue — a human always makes the call.

import { useCallback, useEffect, useRef, useState } from "react";

type Verdict = {
  winProbability: number | null;
  weaknesses: string[];
  recommendations: string[];
};

type RunState = {
  status: "running" | "complete" | "failed";
  startedAt: number;
  finishedAt?: number;
  verdict?: Verdict;
  error?: string;
  decisionId?: string;
};

export default function GoNoGoPanel({ draftId }: { draftId: string }) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<RunState | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/drafts/${draftId}/go-no-go`);
      if (!res.ok) return;
      const d = (await res.json()) as { available?: boolean; state?: RunState | null };
      setAvailable(Boolean(d.available));
      setState(d.state ?? null);
    } catch {
      // transient — next poll retries
    }
  }, [draftId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a run is in flight (sims take 10–30 min; 20s cadence).
  useEffect(() => {
    if (state?.status === "running") {
      pollRef.current = window.setInterval(() => void refresh(), 20_000);
      return () => {
        if (pollRef.current) window.clearInterval(pollRef.current);
      };
    }
    return undefined;
  }, [state?.status, refresh]);

  if (!available) return null;

  async function start() {
    setStarting(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}/go-no-go`, { method: "POST" });
      const d = (await res.json()) as { state?: RunState; error?: string };
      if (res.ok && d.state) setState(d.state);
    } finally {
      setStarting(false);
    }
  }

  const minutes = state ? Math.max(0, Math.round(((state.finishedAt ?? Date.now()) - state.startedAt) / 60_000)) : 0;
  const win = state?.verdict?.winProbability ?? null;

  return (
    <div className="mt-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
            Go / No-Go
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-stone-500">
            Simulates a review panel scoring this application against a competitive field —{" "}
            <strong>before</strong> you spend 40+ hours. Advisory until backtested; the verdict files
            into Decisions for your call.
          </p>
        </div>
        {(!state || state.status === "failed") && (
          <button
            onClick={() => void start()}
            disabled={starting}
            className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
          >
            {starting ? "Starting…" : state?.status === "failed" ? "Run again" : "Run Go/No-Go"}
          </button>
        )}
      </div>

      {state?.status === "running" && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500" />
          Review panel deliberating — {minutes} min elapsed (typically 10–30). You can leave this page;
          the verdict lands in Decisions.
        </div>
      )}

      {state?.status === "failed" && (
        <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          Run failed: {state.error ?? "unknown"}
        </p>
      )}

      {state?.status === "complete" && state.verdict && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-3">
            <span
              className={`rounded-lg border px-3 py-1.5 text-lg font-bold ${
                win == null
                  ? "border-stone-300 bg-stone-50 text-stone-600"
                  : win >= 40
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-rose-300 bg-rose-50 text-rose-700"
              }`}
            >
              {win == null ? "—" : `${win}%`}
            </span>
            <div className="text-xs text-stone-600">
              <div className="font-semibold text-stone-800">
                {win == null ? "Win probability unparsed" : win >= 40 ? "Pursue — with fixes" : "Leaning no-go"}
              </div>
              <div>Simulated in {minutes} min · verdict filed in Decisions</div>
            </div>
          </div>
          {state.verdict.weaknesses.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
                Panel-flagged weaknesses
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-stone-700">
                {state.verdict.weaknesses.slice(0, 5).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {state.verdict.recommendations.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
                Positioning recommendations
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-stone-700">
                {state.verdict.recommendations.slice(0, 5).map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
