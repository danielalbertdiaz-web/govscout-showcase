"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { AutoDraftLogEntry, AutoDraftQueueEntry } from "@/lib/auto-draft";

type InitialState = {
  enabled: boolean;
  envForcesDisabled: boolean;
  threshold: number;
  thresholdDefault: number;
  rateLimit24h: number;
  log: AutoDraftLogEntry[];
  queue: AutoDraftQueueEntry[];
};

export function AutoDraftSettingsPanel({ initial }: { initial: InitialState }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [threshold, setThreshold] = useState(initial.threshold);
  const [log, setLog] = useState(initial.log);
  const [queue, setQueue] = useState(initial.queue);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function patchSettings(next: { enabled?: boolean; threshold?: number }) {
    setStatus(null);
    const res = await fetch("/api/settings/auto-draft", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!res.ok) {
      setStatus(`Save failed: ${res.status}`);
      return;
    }
    const json = (await res.json()) as { enabled: boolean; threshold: number };
    setEnabled(json.enabled);
    setThreshold(json.threshold);
    setStatus("Saved.");
  }

  async function releaseQueued(queueId: string) {
    setStatus(null);
    const res = await fetch("/api/settings/auto-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queueId }),
    });
    if (!res.ok) {
      setStatus(`Release failed: ${res.status}`);
      return;
    }
    const json = (await res.json()) as {
      outcome: string;
      reason: string | null;
      draftId: string | null;
    };
    if (json.outcome === "created") {
      setStatus(`Released — draft ${json.draftId?.slice(0, 8)} created.`);
      setQueue((q) => q.filter((row) => row.id !== queueId));
      // refresh log inline
      const r2 = await fetch("/api/settings/auto-draft");
      if (r2.ok) {
        const j2 = (await r2.json()) as { log: AutoDraftLogEntry[] };
        setLog(j2.log);
      }
    } else {
      setStatus(`Release no-op: ${json.outcome}${json.reason ? ` (${json.reason})` : ""}`);
    }
  }

  return (
    <section className="rounded-lg border border-white/10 bg-black/30 p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Auto-draft trigger</h2>
        <span className="text-[11px] text-white/50">Sprint 7</span>
      </header>
      <p className="text-sm text-white/70">
        When a scored opportunity crosses the threshold, GovScout assembles a draft from your
        boilerplate library and partner manifest, drops it into Drafts in{" "}
        <code className="rounded bg-white/10 px-1 py-0.5 text-[11px]">auto_drafted</code> status,
        and posts a Suggestion Inbox entry. Submission still requires the pre-flight gate.
      </p>

      {initial.envForcesDisabled && (
        <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          Environment variable <code>AUTO_DRAFT_ENABLED</code> is forcing this off. UI toggle is
          ignored until the env is cleared.
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex items-start gap-3 rounded border border-white/10 bg-white/5 p-3">
          <input
            type="checkbox"
            checked={enabled}
            disabled={pending || initial.envForcesDisabled}
            onChange={(e) =>
              startTransition(() => {
                void patchSettings({ enabled: e.target.checked });
              })
            }
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-white">Auto-draft when score ≥ threshold</span>
            <span className="block text-xs text-white/60">
              Single boolean kill switch. Persists to <code>alfred_settings</code>.
            </span>
          </span>
        </label>

        <label className="flex flex-col gap-2 rounded border border-white/10 bg-white/5 p-3">
          <span className="text-sm font-medium text-white">Threshold (0–100)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={threshold}
            disabled={pending}
            onChange={(e) => setThreshold(Number(e.target.value))}
            onBlur={() =>
              startTransition(() => {
                void patchSettings({ threshold });
              })
            }
            className="rounded border border-white/10 bg-black/40 px-2 py-1 text-sm text-white"
          />
          <span className="text-[11px] text-white/50">
            Default {initial.thresholdDefault}. Brief: ≥ 8/10 → ≥ 80/100. Cap {initial.rateLimit24h}{" "}
            auto-drafts per 24h; over-rate goes to the queue below.
          </span>
        </label>
      </div>

      {status && <div className="mt-3 text-xs text-white/70">{status}</div>}

      {queue.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-white">
            Queued auto-drafts ({queue.length})
          </h3>
          <ul className="space-y-2">
            {queue.map((q) => (
              <li
                key={q.id}
                className="flex items-center justify-between gap-3 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-white">{q.opportunityKey}</div>
                  <div className="text-[11px] text-white/60">
                    score {Math.round(q.score)} / threshold {Math.round(q.threshold)} ·{" "}
                    {new Date(q.createdAt).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() =>
                    startTransition(() => {
                      void releaseQueued(q.id);
                    })
                  }
                  disabled={pending}
                  className="gs-chip gs-chip-cta rounded-md border px-3 py-1 text-xs font-semibold"
                >
                  Release
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold text-white">Recent trigger log</h3>
        {log.length === 0 ? (
          <p className="text-xs text-white/50">No triggers yet.</p>
        ) : (
          <ul className="divide-y divide-white/5 overflow-hidden rounded border border-white/10 bg-black/30">
            {log.map((row) => (
              <li key={row.id} className="px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white/80">
                    <OutcomeBadge outcome={row.outcome} />{" "}
                    <span className="font-mono">{row.opportunityKey}</span>
                  </span>
                  <span className="text-white/40">{new Date(row.createdAt).toLocaleString()}</span>
                </div>
                <div className="mt-1 text-[11px] text-white/60">
                  score {Math.round(row.score)} / threshold {Math.round(row.threshold)}
                  {row.reason ? ` — ${row.reason}` : ""}
                  {row.draftId && (
                    <>
                      {" — "}
                      <Link href={`/drafts/${row.draftId}`} className="text-sky-300 underline">
                        draft {row.draftId.slice(0, 8)}
                      </Link>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const tone: Record<string, string> = {
    created: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    skipped: "bg-stone-500/20 text-stone-300 border-stone-500/30",
    queued: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    blocked_memory_guard: "bg-rose-500/20 text-rose-300 border-rose-500/30",
  };
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        tone[outcome] ?? "bg-white/10 text-white/70 border-white/20"
      }`}
    >
      {outcome.replace(/_/g, " ")}
    </span>
  );
}
