"use client";

import { useMemo, useState } from "react";

type Block = {
  id: string;
  key: string;
  title: string;
  bodyMarkdown: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  notes: string | null;
  category: string | null;
  status: string;
  // §14.9 reuse controls (migration 033), served by lib/boilerplate.ts.
  approvalStatus: string;
  approvedBy: string | null;
  approvedAt: number | null;
  source: string | null;
  contentHash: string | null;
  effectiveFrom: number | null;
  expiresAt: number | null;
  confidentiality: string;
  permittedUse: string | null;
  restrictedFunders: string[];
  doNotReuse: boolean;
  doNotReuseReason: string | null;
  supersededBy: string | null;
  /** Server-computed: would drafting use this block right now, and why not. */
  reuse: { usable: boolean; reason: string | null };
};

const APPROVAL_OPTIONS = ["unreviewed", "needs_review", "approved", "rejected"] as const;
const CONFIDENTIALITY_OPTIONS = ["public", "internal", "confidential"] as const;

function fmt(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** epoch ms -> yyyy-mm-dd for a date input; "" when unset. */
function msToDateInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

/** yyyy-mm-dd -> epoch ms (end of day for expiry so the named day still counts). */
function dateInputToMs(s: string, endOfDay: boolean): number | null {
  if (!s.trim()) return null;
  const t = Date.parse(`${s}T${endOfDay ? "23:59:59" : "00:00:00"}`);
  return Number.isFinite(t) ? t : null;
}

export default function BoilerplateView({ initial }: { initial: Block[] }) {
  const [items, setItems] = useState<Block[]>(initial);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    bodyMarkdown: "",
    notes: "",
    approvalStatus: "unreviewed",
    confidentiality: "internal",
    effectiveFrom: "",
    expiresAt: "",
    doNotReuse: false,
    doNotReuseReason: "",
    restrictedFunders: "",
    supersededBy: "",
    source: "",
    permittedUse: "",
  });
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    if (!ql) return items;
    return items.filter(
      (b) =>
        b.title.toLowerCase().includes(ql) ||
        b.key.toLowerCase().includes(ql) ||
        b.bodyMarkdown.toLowerCase().includes(ql) ||
        (b.category ?? "").toLowerCase().includes(ql) ||
        (b.notes ?? "").toLowerCase().includes(ql),
    );
  }, [items, q]);

  // P7 — group by category so the library reads as a table of contents
  // instead of one undifferentiated scroll.
  const grouped = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    for (const b of filtered) {
      const cat = b.category?.trim() || "Uncategorized";
      const arr = m.get(cat) ?? [];
      arr.push(b);
      m.set(cat, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  async function seed() {
    setSeedMsg(null);
    const r = await fetch("/api/boilerplate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "seed" }),
    });
    if (!r.ok) {
      setSeedMsg("Seed failed.");
      return;
    }
    const data = (await r.json()) as {
      seeded: number;
      existing: number;
      needsReview?: number;
    };
    const reviewNote =
      data.needsReview && data.needsReview > 0
        ? ` (${data.needsReview} flagged needs-review)`
        : "";
    setSeedMsg(
      data.seeded === 0
        ? `Library already has ${data.existing} block${data.existing === 1 ? "" : "s"}.`
        : `Seeded ${data.seeded} new block${data.seeded === 1 ? "" : "s"}${reviewNote}.`,
    );
    const refresh = await fetch("/api/boilerplate");
    if (refresh.ok) {
      const d = (await refresh.json()) as { blocks: Block[] };
      setItems(d.blocks);
    }
  }

  async function remove(b: Block) {
    if (!window.confirm(`Delete "${b.title}" (${b.key})? This unpins it from any drafts and cannot be undone.`)) return;
    const r = await fetch(`/api/boilerplate/${b.id}`, { method: "DELETE" });
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string };
      setSaveMsg(`Delete failed: ${e.error ?? r.statusText}`);
      return;
    }
    setItems((s) => s.filter((x) => x.id !== b.id));
    setSaveMsg("Block deleted.");
    setTimeout(() => setSaveMsg(null), 2000);
  }

  function startEdit(b: Block) {
    setEditing(b.id);
    setDraft({
      title: b.title,
      bodyMarkdown: b.bodyMarkdown,
      notes: b.notes ?? "",
      approvalStatus: b.approvalStatus,
      confidentiality: b.confidentiality,
      effectiveFrom: msToDateInput(b.effectiveFrom),
      expiresAt: msToDateInput(b.expiresAt),
      doNotReuse: b.doNotReuse,
      doNotReuseReason: b.doNotReuseReason ?? "",
      restrictedFunders: b.restrictedFunders.join(", "),
      supersededBy: b.supersededBy ?? "",
      source: b.source ?? "",
      permittedUse: b.permittedUse ?? "",
    });
    setSaveMsg(null);
  }

  async function save(id: string, bumpVersion: boolean) {
    setSaveMsg(null);
    const r = await fetch(`/api/boilerplate/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: draft.title,
        bodyMarkdown: draft.bodyMarkdown,
        notes: draft.notes,
        bumpVersion,
        approvalStatus: draft.approvalStatus,
        confidentiality: draft.confidentiality,
        effectiveFrom: dateInputToMs(draft.effectiveFrom, false),
        expiresAt: dateInputToMs(draft.expiresAt, true),
        doNotReuse: draft.doNotReuse,
        doNotReuseReason: draft.doNotReuseReason.trim() || null,
        restrictedFunders: draft.restrictedFunders
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
        supersededBy: draft.supersededBy.trim() || null,
        source: draft.source.trim() || null,
        permittedUse: draft.permittedUse.trim() || null,
      }),
    });
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string };
      setSaveMsg(`Save failed: ${e.error ?? r.statusText}`);
      return;
    }
    const data = (await r.json()) as { block: Block };
    setItems((s) => s.map((x) => (x.id === id ? data.block : x)));
    setEditing(null);
    setSaveMsg(bumpVersion ? `Saved (v${data.block.version})` : "Saved.");
    setTimeout(() => setSaveMsg(null), 2000);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by key, title, body…"
          className="grow rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
        />
        <button
          onClick={() => void seed()}
          title="Idempotent — loads the curated set plus every file in data/blocks/. Re-running adds only what's missing."
          className="rounded-md border border-violet-700 bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800"
        >
          {items.length === 0 ? "Seed library" : "Sync library"}
        </button>
        {seedMsg && <span className="text-xs text-violet-900">{seedMsg}</span>}
        {saveMsg && <span className="text-xs text-emerald-700">{saveMsg}</span>}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-sm text-stone-500">
          No blocks match. Seed the curated set or add one via the API.
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([cat, blocks]) => (
            <section key={cat}>
              <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-stone-600">
                {cat.replace(/_/g, " ")}
                <span className="text-stone-400">· {blocks.length}</span>
              </h2>
              <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {blocks.map((b) => (
            <li
              key={b.id}
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <header className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] font-mono text-stone-700">
                      {b.key}
                    </code>
                    <span className="rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800">
                      v{b.version}
                    </span>
                    {b.category && (
                      <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-600">
                        {b.category}
                      </span>
                    )}
                    {b.status === "needs_review" && (
                      <span
                        title="Still contains placeholders ([insert …], [RESEARCH FLAG …]) — needs human input before use."
                        className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
                      >
                        ⚠ needs review
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-sm font-semibold text-stone-900">{b.title}</div>
                  {b.notes && (
                    <p className="mt-1 text-[11px] italic text-stone-600">{b.notes}</p>
                  )}
                  {/* §14.9: is this block actually reaching proposals? */}
                  <div
                    className={`mt-1 text-[11px] font-semibold ${
                      b.reuse.usable ? "text-emerald-700" : "text-red-700"
                    }`}
                  >
                    {b.reuse.usable
                      ? "✓ Usable by drafting"
                      : `✗ Withheld from drafting — ${b.reuse.reason}`}
                  </div>
                  <div className="mt-1 text-[11px] text-stone-500">
                    Updated {fmt(b.updatedAt)} · {b.bodyMarkdown.length.toLocaleString()} chars ·{" "}
                    {wordCount(b.bodyMarkdown).toLocaleString()} words
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => (editing === b.id ? setEditing(null) : startEdit(b))}
                    className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                  >
                    {editing === b.id ? "Cancel" : "Edit"}
                  </button>
                  <button
                    onClick={() => void remove(b)}
                    title="Delete this block (also unpins it from any drafts)"
                    className="rounded-md border border-red-300 bg-white px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                  >
                    Delete
                  </button>
                </div>
              </header>

              {editing === b.id ? (
                <div className="mt-3 space-y-2">
                  <input
                    type="text"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className="block w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    value={draft.notes}
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                    placeholder="Notes (internal)"
                    className="block w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs"
                  />
                  <textarea
                    value={draft.bodyMarkdown}
                    onChange={(e) => setDraft({ ...draft, bodyMarkdown: e.target.value })}
                    rows={12}
                    className="block w-full rounded-md border border-stone-300 bg-white px-3 py-2 font-mono text-xs"
                  />
                  <div className="text-[11px] text-stone-500">
                    {draft.bodyMarkdown.length.toLocaleString()} chars ·{" "}
                    {wordCount(draft.bodyMarkdown).toLocaleString()} words
                  </div>

                  {/* §14.9 reuse controls — secondary to title/body on purpose. */}
                  <fieldset className="rounded-md border border-stone-200 bg-stone-50/60 p-3">
                    <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                      Reuse controls
                    </legend>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label className="block text-[11px]">
                        <span className="font-medium text-stone-600">Approval status</span>
                        <select
                          value={draft.approvalStatus}
                          onChange={(e) => setDraft({ ...draft, approvalStatus: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        >
                          {APPROVAL_OPTIONS.map((o) => (
                            <option key={o} value={o}>
                              {o.replace(/_/g, " ")}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block text-[11px]">
                        <span className="font-medium text-stone-600">Confidentiality</span>
                        <select
                          value={draft.confidentiality}
                          onChange={(e) => setDraft({ ...draft, confidentiality: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        >
                          {CONFIDENTIALITY_OPTIONS.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block text-[11px]">
                        <span className="font-medium text-stone-600">Effective from</span>
                        <input
                          type="date"
                          value={draft.effectiveFrom}
                          onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="block text-[11px]">
                        <span className="font-medium text-stone-600">Expires</span>
                        <input
                          type="date"
                          value={draft.expiresAt}
                          onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-[11px] sm:col-span-2">
                        <input
                          type="checkbox"
                          checked={draft.doNotReuse}
                          onChange={(e) => setDraft({ ...draft, doNotReuse: e.target.checked })}
                        />
                        <span className="font-medium text-stone-600">Do not reuse</span>
                        <input
                          type="text"
                          value={draft.doNotReuseReason}
                          onChange={(e) => setDraft({ ...draft, doNotReuseReason: e.target.value })}
                          placeholder="Reason (shown wherever the block is withheld)"
                          className="grow rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="block text-[11px] sm:col-span-2">
                        <span className="font-medium text-stone-600">Restricted funders</span>
                        <span className="ml-1 text-stone-400">comma-separated; block is withheld for these</span>
                        <input
                          type="text"
                          value={draft.restrictedFunders}
                          onChange={(e) => setDraft({ ...draft, restrictedFunders: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="block text-[11px]">
                        <span className="font-medium text-stone-600">Superseded by</span>
                        <span className="ml-1 text-stone-400">block key</span>
                        <input
                          type="text"
                          value={draft.supersededBy}
                          onChange={(e) => setDraft({ ...draft, supersededBy: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 font-mono text-xs"
                        />
                      </label>
                      <label className="block text-[11px]">
                        <span className="font-medium text-stone-600">Source</span>
                        <span className="ml-1 text-stone-400">where this claim comes from</span>
                        <input
                          type="text"
                          value={draft.source}
                          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                      </label>
                      <label className="block text-[11px] sm:col-span-2">
                        <span className="font-medium text-stone-600">Permitted use</span>
                        <input
                          type="text"
                          value={draft.permittedUse}
                          onChange={(e) => setDraft({ ...draft, permittedUse: e.target.value })}
                          className="mt-0.5 block w-full rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                      </label>
                    </div>
                  </fieldset>

                  <div className="flex gap-2">
                    <button
                      onClick={() => void save(b.id, false)}
                      className="rounded-md border border-stone-400 bg-white px-3 py-1 text-xs font-semibold text-stone-800 hover:bg-stone-50"
                    >
                      Save (no version bump)
                    </button>
                    <button
                      onClick={() => void save(b.id, true)}
                      className="rounded-md border border-violet-700 bg-violet-700 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-800"
                    >
                      Save & bump → v{b.version + 1}
                    </button>
                  </div>
                </div>
              ) : (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-emerald-700 hover:text-emerald-900">
                    Show content
                  </summary>
                  <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-3 font-mono text-[11px] leading-5 text-stone-800 ring-1 ring-stone-200">
                    {b.bodyMarkdown}
                  </pre>
                </details>
              )}
            </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
