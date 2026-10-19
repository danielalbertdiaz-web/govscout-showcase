"use client";

// P14 — scout roster: the three built-in verticals plus operator-created
// scouts (made here or via "Save this search as a scout" on /search).
// Custom scouts can be paused or deleted; built-ins are code-managed.

import { useCallback, useEffect, useState } from "react";

type ProfileLite = {
  id: string;
  label: string;
  champion: string;
  keywords: string[];
  naics: string[];
  enabled: boolean;
};

export function ScoutProfilesPanel() {
  const [builtin, setBuiltin] = useState<ProfileLite[]>([]);
  const [custom, setCustom] = useState<ProfileLite[]>([]);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const [newNaics, setNewNaics] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/scouts/profiles", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setBuiltin(data.builtin ?? []);
    setCustom(data.custom ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setErr(null);
    setCreating(true);
    try {
      const res = await fetch("/api/scouts/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: newLabel,
          keywords: newKeywords.split(",").map((s) => s.trim()).filter(Boolean),
          naics: newNaics.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error ?? "Could not create scout.");
        return;
      }
      setNewLabel("");
      setNewKeywords("");
      setNewNaics("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch("/api/scouts/profiles", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    await load();
  }

  async function remove(id: string, label: string) {
    if (!window.confirm(`Delete scout "${label}"? Future scans stop including it.`)) return;
    await fetch(`/api/scouts/profiles?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  function chip(p: ProfileLite, isCustom: boolean) {
    return (
      <li
        key={p.id}
        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${
          p.enabled ? "border-stone-200 bg-white" : "border-stone-200 bg-stone-50 opacity-70"
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-stone-900">{p.label}</span>
            <span className="rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">
              {isCustom ? "custom" : p.champion}
            </span>
            {!p.enabled && (
              <span className="text-[10px] font-semibold uppercase text-stone-500">paused</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-stone-500" title={p.keywords.join(", ")}>
            {p.keywords.slice(0, 6).join(" · ")}
            {p.keywords.length > 6 ? ` +${p.keywords.length - 6}` : ""}
            {p.naics.length > 0 ? ` — NAICS ${p.naics.join(", ")}` : ""}
          </div>
        </div>
        {isCustom && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => void toggle(p.id, !p.enabled)}
              className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
            >
              {p.enabled ? "Pause" : "Resume"}
            </button>
            <button
              onClick={() => void remove(p.id, p.label)}
              className="rounded-md border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-600">
          Scout verticals — what the rails hunt for
        </h2>
        <span className="text-[11px] text-stone-500">
          {builtin.length} built-in · {custom.length} custom
        </span>
      </div>
      <ul className="mt-3 space-y-2">
        {builtin.map((p) => chip(p, false))}
        {custom.map((p) => chip(p, true))}
      </ul>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-stone-700 hover:text-stone-900">
          ⊕ Add a scout (or use &ldquo;Save this search as a scout&rdquo; on the Search page)
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Name — e.g. Housing & homelessness"
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            value={newKeywords}
            onChange={(e) => setNewKeywords(e.target.value)}
            placeholder="Keywords, comma-separated"
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            value={newNaics}
            onChange={(e) => setNewNaics(e.target.value)}
            placeholder="NAICS codes (optional)"
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
        </div>
        {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
        <button
          onClick={() => void create()}
          disabled={creating || !newLabel.trim() || !newKeywords.trim()}
          className="mt-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create scout"}
        </button>
        <p className="mt-1.5 text-[11px] leading-4 text-stone-500">
          New scouts join every lane (foundations, teaming, underspend) on the next scan —
          run one now with the button above to see it work.
        </p>
      </details>
    </section>
  );
}
