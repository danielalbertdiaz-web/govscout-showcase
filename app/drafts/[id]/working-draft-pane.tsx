"use client";

import { useCallback, useEffect, useState } from "react";

// Item 2.2: the Working Draft side pane. Holds blocks promoted out of the
// section editor as collapsible rows (collapsed by default), supports reorder +
// remove, and assembles them into one combined, downloadable document stored
// against the draft. It refetches whenever a SectionCard fires the
// "working-draft:changed" event, so the promote button elsewhere on the page
// updates the pane without prop-drilling through the 1,100-line Workbench.

export const WORKING_DRAFT_EVENT = "working-draft:changed";

type Item = {
  id: string;
  title: string;
  bodyMarkdown: string;
  sourceKind: string;
  sourceRef: string | null;
  position: number;
};

type Assembly = { id: string; contentMarkdown: string; itemCount: number; createdAt: number };

export default function WorkingDraftPane({
  draftId,
  documentTitle,
}: {
  draftId: string;
  documentTitle: string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [assembly, setAssembly] = useState<Assembly | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const base = `/api/drafts/${draftId}/working-draft`;

  const load = useCallback(async () => {
    const r = await fetch(base);
    if (!r.ok) return;
    const d = (await r.json()) as { items: Item[]; assembly: Assembly | null };
    setItems(d.items);
    setAssembly(d.assembly);
  }, [base]);

  useEffect(() => {
    // load() only setStates AFTER an awaited fetch, so there's no synchronous
    // cascading render — the static rule can't see across the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const handler = () => void load();
    window.addEventListener(WORKING_DRAFT_EVENT, handler);
    return () => window.removeEventListener(WORKING_DRAFT_EVENT, handler);
  }, [load]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function reorder(index: number, dir: -1 | 1) {
    const next = [...items];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next); // optimistic
    await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reorder", orderedIds: next.map((i) => i.id) }),
    });
  }

  async function remove(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic
    await fetch(`${base}/${id}`, { method: "DELETE" });
  }

  async function assemble() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "assemble", documentTitle }),
      });
      if (!r.ok) {
        setMsg("Assemble failed.");
        return;
      }
      const d = (await r.json()) as { assembly: Assembly };
      setAssembly(d.assembly);
      setMsg(`Assembled ${d.assembly.itemCount} block${d.assembly.itemCount === 1 ? "" : "s"}.`);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!assembly) return;
    const blob = new Blob([assembly.contentMarkdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${documentTitle || "working-draft"}.md`.replace(/[^\w.\- ]+/g, "_");
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="mt-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
            Working Draft
          </h2>
          <p className="mt-0.5 text-xs text-stone-500">
            Promoted blocks, assembled in order into one document.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-emerald-700">{msg}</span>}
          <button
            onClick={() => void assemble()}
            disabled={busy || items.length === 0}
            className="rounded-md border border-violet-700 bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-40"
          >
            {busy ? "Assembling…" : "Draft (assemble)"}
          </button>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-6 text-center text-xs text-stone-500">
          No blocks yet. Use <span className="font-semibold">→ Working Draft</span> on a finished
          section to promote it here.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((it, idx) => {
            const open = expanded.has(it.id);
            return (
              <li key={it.id} className="rounded-lg border border-stone-200 bg-stone-50/60">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => toggle(it.id)}
                    className="text-stone-500 hover:text-stone-900"
                    aria-label={open ? "Collapse" : "Expand"}
                  >
                    {open ? "▾" : "▸"}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900">
                    {it.title}
                  </span>
                  <span className="rounded-full border border-stone-200 bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-500">
                    {it.sourceKind}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => void reorder(idx, -1)}
                      disabled={idx === 0}
                      className="rounded border border-stone-300 bg-white px-1.5 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-30"
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => void reorder(idx, 1)}
                      disabled={idx === items.length - 1}
                      className="rounded border border-stone-300 bg-white px-1.5 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-30"
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => void remove(it.id)}
                      className="rounded border border-rose-200 bg-white px-1.5 text-xs text-rose-600 hover:bg-rose-50"
                      aria-label="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {open && (
                  <pre className="mx-3 mb-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-white p-3 font-mono text-[11px] leading-5 text-stone-800 ring-1 ring-stone-200">
                    {it.bodyMarkdown}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {assembly && (
        <div className="mt-4 rounded-lg border border-stone-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-stone-600">
              Assembled document ({assembly.itemCount} block{assembly.itemCount === 1 ? "" : "s"})
            </span>
            <button
              onClick={download}
              className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              ↓ Download .md
            </button>
          </div>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-3 font-mono text-[11px] leading-5 text-stone-800 ring-1 ring-stone-200">
            {assembly.contentMarkdown}
          </pre>
        </div>
      )}
    </section>
  );
}
