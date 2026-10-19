"use client";

import { useCallback, useEffect, useState } from "react";
import { WORKING_DRAFT_EVENT } from "./working-draft-pane";

// Item 2.3: RFP Synthesizer panel. Reads the draft's loaded NOFO, lists the
// required response sections the funder demands, and (per-section or in a batch)
// asks the existing draft engine to write each one in that solicitation's tone,
// keyed to its evaluation criteria. Each completed section is stored as a
// Working Draft block (Item 2.2) — sanitized server-side through the 1.6
// guardrail — and we fire WORKING_DRAFT_EVENT so the sibling pane refreshes
// progressively as sections land.

type SynthSection = { title: string; slug: string };
type Status = "idle" | "running" | "done" | "error";

export default function SynthesizerPanel({ draftId }: { draftId: string }) {
  const [hasNofo, setHasNofo] = useState(false);
  const [hasCriteria, setHasCriteria] = useState(false);
  const [sections, setSections] = useState<SynthSection[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const base = `/api/drafts/${draftId}/synthesize`;

  const load = useCallback(async () => {
    const r = await fetch(base);
    if (!r.ok) return;
    const d = (await r.json()) as { hasNofo: boolean; sections: SynthSection[]; hasEvaluationCriteria: boolean };
    setHasNofo(d.hasNofo);
    setHasCriteria(d.hasEvaluationCriteria);
    setSections(d.sections);
  }, [base]);

  useEffect(() => {
    // load() only setStates AFTER an awaited fetch, so there's no synchronous
    // cascading render — the static rule can't see across the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const synthesizeOne = useCallback(
    async (slug: string): Promise<boolean> => {
      setStatus((p) => ({ ...p, [slug]: "running" }));
      try {
        const r = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sections: [slug] }),
        });
        if (!r.ok) {
          setStatus((p) => ({ ...p, [slug]: "error" }));
          return false;
        }
        const d = (await r.json()) as { created: number; results: { error?: string }[] };
        const ok = d.created > 0;
        setStatus((p) => ({ ...p, [slug]: ok ? "done" : "error" }));
        if (ok) window.dispatchEvent(new CustomEvent(WORKING_DRAFT_EVENT));
        return ok;
      } catch {
        setStatus((p) => ({ ...p, [slug]: "error" }));
        return false;
      }
    },
    [base],
  );

  async function synthesizeAll() {
    setBusy(true);
    setMsg(null);
    let ok = 0;
    for (const s of sections) {
      const r = await synthesizeOne(s.slug);
      if (r) ok += 1;
    }
    setBusy(false);
    setMsg(`Synthesized ${ok}/${sections.length} section${sections.length === 1 ? "" : "s"} into the Working Draft.`);
  }

  return (
    <section className="mt-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">RFP Synthesizer</h2>
          <p className="mt-0.5 text-xs text-stone-500">
            Writes each required section in the solicitation&apos;s tone, keyed to its evaluation
            criteria, straight into the Working Draft.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-emerald-700">{msg}</span>}
          <button
            onClick={() => void synthesizeAll()}
            disabled={busy || !hasNofo || sections.length === 0}
            className="rounded-md border border-violet-700 bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-40"
          >
            {busy ? "Synthesizing…" : "Synthesize all →"}
          </button>
        </div>
      </header>

      {!hasNofo ? (
        <div className="mt-3 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 p-6 text-center text-xs text-amber-800">
          No NOFO is loaded for this draft yet. Link or extract a solicitation so the synthesizer can
          read its required sections and evaluation criteria.
        </div>
      ) : (
        <>
          {!hasCriteria && (
            <p className="mt-3 rounded border border-stone-200 bg-stone-50 px-3 py-1.5 text-[11px] text-stone-500">
              This NOFO has no machine-readable evaluation criteria — sections will emphasize impact,
              feasibility, and capacity. Re-extract the NOFO if criteria were missed.
            </p>
          )}
          <ul className="mt-3 space-y-2">
            {sections.map((s) => {
              const st = status[s.slug] ?? "idle";
              return (
                <li
                  key={s.slug}
                  className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900">{s.title}</span>
                  {st === "done" && <span className="text-[11px] font-semibold text-emerald-700">✓ in Working Draft</span>}
                  {st === "error" && <span className="text-[11px] font-semibold text-rose-600">failed</span>}
                  <button
                    onClick={() => void synthesizeOne(s.slug)}
                    disabled={busy || st === "running"}
                    className="rounded border border-stone-300 bg-white px-2.5 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-40"
                  >
                    {st === "running" ? "Writing…" : st === "done" ? "Re-synthesize" : "Synthesize"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
