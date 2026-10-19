"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Foundation = {
  id: string;
  sourceLabel: string;
  title: string;
  url: string | null;
  deadlineText: string | null;
  deadlineDate: string | null;
  fundingMin: string | null;
  fundingMax: string | null;
  focusArea: string | null;
  geography: string | null;
  notes: string | null;
  status: "open" | "closed" | "won" | "lost" | "declined";
  sourceKind: string;
};

const STATUS_PILL: Record<Foundation["status"], string> = {
  open: "border-sky-300 bg-sky-50 text-sky-900",
  closed: "border-stone-300 bg-stone-100 text-stone-700",
  won: "border-emerald-500 bg-emerald-600 text-white",
  lost: "border-rose-300 bg-rose-50 text-rose-900",
  declined: "border-stone-400 bg-stone-200 text-stone-700",
};

export default function FoundationsPanel() {
  const [items, setItems] = useState<Foundation[]>([]);
  const [loading, setLoading] = useState(true);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    sourceLabel: "",
    title: "",
    url: "",
    deadlineText: "",
    fundingMin: "",
    fundingMax: "",
    focusArea: "",
    geography: "",
    notes: "",
  });
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/foundations");
      if (r.ok) {
        const data = (await r.json()) as { foundations: Foundation[] };
        setItems(data.foundations);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function seed() {
    setSeedMsg(null);
    const r = await fetch("/api/foundations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "seed" }),
    });
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string };
      setSeedMsg(`Seed failed: ${e.error ?? r.statusText}`);
      return;
    }
    const data = (await r.json()) as { seeded: number; existing: number };
    setSeedMsg(
      data.seeded === 0
        ? `Library already has ${data.existing} foundation${data.existing === 1 ? "" : "s"}.`
        : `Seeded ${data.seeded} foundation${data.seeded === 1 ? "" : "s"}.`,
    );
    await refresh();
  }

  async function submit() {
    if (!form.title.trim() || !form.sourceLabel.trim()) return;
    const r = await fetch("/api/foundations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (r.ok) {
      setForm({
        sourceLabel: "",
        title: "",
        url: "",
        deadlineText: "",
        fundingMin: "",
        fundingMax: "",
        focusArea: "",
        geography: "",
        notes: "",
      });
      setAdding(false);
      await refresh();
    }
  }

  async function setStatus(id: string, status: Foundation["status"]) {
    const prev = items;
    setItems((s) => s.map((x) => (x.id === id ? { ...x, status } : x)));
    const r = await fetch(`/api/foundations/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) setItems(prev);
  }

  const sources = useMemo(() => {
    const s = new Set<string>();
    for (const i of items) s.add(i.sourceLabel);
    return ["all", ...Array.from(s).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (sourceFilter !== "all" && i.sourceLabel !== sourceFilter) return false;
      if (statusFilter !== "all" && i.status !== statusFilter) return false;
      return true;
    });
  }, [items, sourceFilter, statusFilter]);

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/40 p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-violet-900">
            🪙 Non-government grants ({items.length})
          </div>
          <div className="text-[11px] text-violet-800/80">
            Foundations + corporate giving — manually curated, not scraped.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="rounded-md border border-violet-300 bg-white px-2 py-1 text-xs"
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? `All sources (${items.length})` : s}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-violet-300 bg-white px-2 py-1 text-xs"
          >
            <option value="all">All status</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="declined">Declined</option>
          </select>
          {items.length === 0 && (
            <button
              onClick={() => void seed()}
              className="rounded-md border border-violet-700 bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-900 hover:bg-violet-200"
            >
              Seed curated list
            </button>
          )}
          <button
            onClick={() => setAdding((s) => !s)}
            className="rounded-md border border-violet-700 bg-violet-700 px-2 py-1 text-xs font-semibold text-white hover:bg-violet-800"
          >
            {adding ? "Cancel" : "+ Add foundation"}
          </button>
        </div>
      </header>

      {seedMsg && (
        <div className="mt-2 rounded-md border border-violet-200 bg-white px-2 py-1 text-xs text-violet-900">
          {seedMsg}
        </div>
      )}

      {adding && (
        <div className="mt-3 grid grid-cols-1 gap-2 rounded-md border border-violet-200 bg-white p-3 md:grid-cols-2">
          <input
            type="text"
            placeholder="Source label (e.g. RWJF)"
            value={form.sourceLabel}
            onChange={(e) => setForm({ ...form, sourceLabel: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="text"
            placeholder="Title / program"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="text"
            placeholder="URL"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs md:col-span-2"
          />
          <input
            type="text"
            placeholder="Deadline (text)"
            value={form.deadlineText}
            onChange={(e) => setForm({ ...form, deadlineText: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="text"
            placeholder="Geography"
            value={form.geography}
            onChange={(e) => setForm({ ...form, geography: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="text"
            placeholder="Funding min ($)"
            value={form.fundingMin}
            onChange={(e) => setForm({ ...form, fundingMin: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="text"
            placeholder="Funding max ($)"
            value={form.fundingMax}
            onChange={(e) => setForm({ ...form, fundingMax: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="text"
            placeholder="Focus area"
            value={form.focusArea}
            onChange={(e) => setForm({ ...form, focusArea: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs md:col-span-2"
          />
          <textarea
            placeholder="Notes / fit / contact"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs md:col-span-2"
            rows={2}
          />
          <button
            onClick={() => void submit()}
            disabled={!form.title.trim() || !form.sourceLabel.trim()}
            className="md:col-span-2 rounded-md border border-violet-700 bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
          >
            Add foundation
          </button>
        </div>
      )}

      {loading ? (
        <div className="mt-3 text-xs text-stone-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="mt-3 text-xs text-stone-600 italic">
          {items.length === 0
            ? "No foundations yet. Use Seed or Add to populate."
            : "No foundations match current filters."}
        </div>
      ) : (
        <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {filtered.map((f) => (
            <li
              key={f.id}
              className="rounded-md border border-violet-200 bg-white p-3 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wider text-violet-700">
                    {f.sourceLabel}
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-stone-900">{f.title}</div>
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL[f.status]}`}
                >
                  {f.status}
                </span>
              </div>
              {f.focusArea && (
                <div className="mt-2 text-xs text-stone-700">{f.focusArea}</div>
              )}
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-stone-600">
                {f.deadlineText && (
                  <div>
                    <span className="font-semibold">Deadline:</span> {f.deadlineText}
                  </div>
                )}
                {f.geography && (
                  <div>
                    <span className="font-semibold">Geo:</span> {f.geography}
                  </div>
                )}
                {(f.fundingMin || f.fundingMax) && (
                  <div className="col-span-2">
                    <span className="font-semibold">Funding:</span>{" "}
                    {f.fundingMin ?? "?"} – {f.fundingMax ?? "?"}
                  </div>
                )}
              </div>
              {f.notes && (
                <p className="mt-2 text-[11px] text-stone-600 italic">{f.notes}</p>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {f.url ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
                  >
                    Open ↗
                  </a>
                ) : (
                  <span />
                )}
                <select
                  value={f.status}
                  onChange={(e) => void setStatus(f.id, e.target.value as Foundation["status"])}
                  className="rounded-md border border-stone-300 bg-white px-1 py-0.5 text-[11px]"
                >
                  <option value="open">open</option>
                  <option value="closed">closed</option>
                  <option value="won">won</option>
                  <option value="lost">lost</option>
                  <option value="declined">declined</option>
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
