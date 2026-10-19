"use client";

import { useCallback, useEffect, useState } from "react";

type Suggestion = {
  id: string;
  body: string;
  status: "open" | "triaged" | "done";
  createdAt: number;
};

type Props = {
  paneContextType: string;
  paneContextId?: string | null;
  /** Show recent open suggestions inline below the input. Default 3. */
  recentLimit?: number;
};

export function SuggestionInbox({ paneContextType, paneContextId, recentLimit = 3 }: Props) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ contextType: paneContextType });
      if (paneContextId) params.set("contextId", paneContextId);
      params.set("status", "open");
      const r = await fetch(`/api/suggestions?${params.toString()}`);
      if (!r.ok) return;
      const data = (await r.json()) as { suggestions: Suggestion[] };
      setItems(data.suggestions.slice(0, recentLimit));
    } catch {
      // ignore
    }
  }, [paneContextId, paneContextType, recentLimit]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submit() {
    if (!body.trim() || submitting) return;
    setSubmitting(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/suggestions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          paneContextType,
          paneContextId: paneContextId ?? null,
        }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setMsg(`Failed: ${e.error ?? r.statusText}`);
      } else {
        setBody("");
        setMsg("Saved.");
        void load();
        setTimeout(() => setMsg(null), 1500);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function markDone(id: string) {
    const r = await fetch(`/api/suggestions/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    if (r.ok) {
      setItems((s) => s.filter((x) => x.id !== id));
    }
  }

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-900">
          💡 Suggestion inbox
        </div>
        {msg && <span className="text-[11px] text-amber-800">{msg}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Alfred, do X about this…"
          className="grow rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-600/20"
          disabled={submitting}
        />
        <button
          onClick={() => void submit()}
          disabled={!body.trim() || submitting}
          className="rounded-md border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Capture"}
        </button>
      </div>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1">
          {items.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-white px-2 py-1 text-xs text-stone-800"
            >
              <span className="truncate">{s.body}</span>
              <button
                onClick={() => void markDone(s.id)}
                className="shrink-0 text-[11px] text-emerald-700 hover:text-emerald-900"
                title="Mark done"
              >
                Done ✓
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
