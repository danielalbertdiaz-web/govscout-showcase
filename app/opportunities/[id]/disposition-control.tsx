"use client";

import { useState } from "react";
import {
  TERMINAL_DISPOSITIONS,
  DISPOSITION_LABELS,
  type Disposition,
} from "@/lib/disposition";

// Item 3.1 — one-click win/loss disposition setter. Records the terminal outcome
// of a pursued opportunity (with an optional one-line note) so the council's
// feedback loop and the /learning calibration curve can learn from it. Setting a
// disposition has no automation side effects beyond logging the outcome.

const TONE: Record<Disposition, string> = {
  won: "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700",
  lost: "border-rose-600 bg-rose-600 text-white hover:bg-rose-700",
  no_go: "border-stone-500 bg-stone-500 text-white hover:bg-stone-600",
  passed_pre_draft: "border-amber-600 bg-amber-600 text-white hover:bg-amber-700",
  expired_no_action: "border-stone-400 bg-stone-400 text-white hover:bg-stone-500",
};

export default function DispositionControl({
  opportunityId,
  initialDisposition,
  initialNote,
  initialAt,
}: {
  opportunityId: string;
  initialDisposition: string | null;
  initialNote: string | null;
  initialAt: number | null;
}) {
  const [disposition, setDisposition] = useState<string | null>(initialDisposition);
  const [note, setNote] = useState(initialNote ?? "");
  const [at, setAt] = useState<number | null>(initialAt);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(payload: { disposition: string | null; note?: string }) {
    setBusy(payload.disposition ?? "clear");
    setError(null);
    try {
      const r = await fetch(`/api/opportunities/${opportunityId}/disposition`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? "Failed to save");
        return;
      }
      const d = (await r.json()) as {
        opportunity: { disposition: string | null; dispositionNote: string | null; dispositionAt: number | null } | null;
      };
      setDisposition(d.opportunity?.disposition ?? null);
      setNote(d.opportunity?.dispositionNote ?? "");
      setAt(d.opportunity?.dispositionAt ?? null);
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
        Outcome
      </h2>
      <p className="mt-1 text-xs text-stone-500">
        Record how this pursuit ended. The council weighs these prior outcomes when
        scoring similar opportunities, and the{" "}
        <a href="/learning" className="text-emerald-700 underline">
          calibration curve
        </a>{" "}
        tracks how honest the scores have been. Logging only — nothing is sent.
      </p>

      {disposition && (
        <p className="mt-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-700">
          Current: <span className="font-semibold">{DISPOSITION_LABELS[disposition as Disposition] ?? disposition}</span>
          {at ? <span className="ml-1 text-stone-400">· {new Date(at).toLocaleDateString()}</span> : null}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {TERMINAL_DISPOSITIONS.map((d) => {
          const active = disposition === d;
          return (
            <button
              key={d}
              onClick={() => void send({ disposition: d, note: note.trim() || undefined })}
              disabled={busy != null}
              className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-40 ${
                active
                  ? TONE[d]
                  : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
              }`}
            >
              {busy === d ? "Saving…" : DISPOSITION_LABELS[d]}
            </button>
          );
        })}
        {disposition && (
          <button
            onClick={() => void send({ disposition: null })}
            disabled={busy != null}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-stone-100 disabled:opacity-40"
          >
            {busy === "clear" ? "Clearing…" : "Clear"}
          </button>
        )}
      </div>

      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional one-line note (why won/lost) — saved with the next outcome you click"
        className="mt-3 w-full rounded-md border border-stone-300 px-3 py-1.5 text-xs text-stone-800 placeholder:text-stone-400 focus:border-emerald-500 focus:outline-none"
      />

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
    </section>
  );
}
