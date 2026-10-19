"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type SnapMeta = {
  id: string;
  snapshotNo: number;
  createdAt: number;
  note: string | null;
};

type DiffMap = Record<string, string>;

type Props = { draftId: string };

function fmt(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DiffLine({ line }: { line: string }) {
  const first = line[0] ?? " ";
  const bg =
    first === "+" ? "bg-emerald-50 text-emerald-900"
    : first === "-" ? "bg-rose-50 text-rose-900"
    : "bg-stone-50 text-stone-700";
  return (
    <div className={`whitespace-pre-wrap px-2 py-0.5 font-mono text-[11px] ${bg}`}>
      {line || " "}
    </div>
  );
}

export default function SnapshotPanel({ draftId }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<SnapMeta[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [openDiffFor, setOpenDiffFor] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffMap | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/drafts/${draftId}/snapshots`);
      if (!r.ok) return;
      const data = (await r.json()) as { snapshots: SnapMeta[] };
      setItems(data.snapshots);
    } catch {
      // ignore
    }
  }, [draftId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function saveVersion() {
    if (saving) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/drafts/${draftId}/snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: note.trim() || null }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setMsg(`Failed: ${e.error ?? r.statusText}`);
      } else {
        const data = (await r.json()) as { snapshot: SnapMeta };
        setMsg(`Saved v${data.snapshot.snapshotNo}`);
        setNote("");
        void refresh();
        setTimeout(() => setMsg(null), 2000);
      }
    } finally {
      setSaving(false);
    }
  }

  async function loadDiff(snapId: string) {
    if (openDiffFor === snapId) {
      setOpenDiffFor(null);
      setDiff(null);
      return;
    }
    setOpenDiffFor(snapId);
    setDiff(null);
    setDiffLoading(true);
    try {
      const r = await fetch(`/api/drafts/${draftId}/snapshots/${snapId}?mode=diff`);
      if (!r.ok) {
        setDiff({});
      } else {
        const data = (await r.json()) as { diff: DiffMap };
        setDiff(data.diff ?? {});
      }
    } finally {
      setDiffLoading(false);
    }
  }

  async function restore(snapId: string, snapshotNo: number) {
    if (!confirm(`Restore the draft to snapshot v${snapshotNo}?\n(Current state is auto-snapshotted first.)`)) {
      return;
    }
    setMsg(null);
    const r = await fetch(`/api/drafts/${draftId}/snapshots/${snapId}/restore`, {
      method: "POST",
    });
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string };
      setMsg(`Restore failed: ${e.error ?? r.statusText}`);
    } else {
      setMsg(`Restored v${snapshotNo}`);
      void refresh();
      router.refresh();
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-violet-900">🗂 Versions ({items.length})</div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. before Riverside review)"
            className="rounded-md border border-violet-300 bg-white px-2 py-1 text-xs text-stone-900 placeholder:text-stone-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
          />
          <button
            onClick={() => void saveVersion()}
            disabled={saving}
            className="rounded-md border border-violet-700 bg-violet-700 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save version"}
          </button>
          {msg && <span className="text-xs text-violet-900">{msg}</span>}
        </div>
      </header>

      {items.length === 0 ? (
        <p className="mt-3 text-xs text-stone-600 italic">
          No saved versions yet. Click &ldquo;Save version&rdquo; to capture the current state.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((s) => (
            <li key={s.id} className="rounded-md border border-violet-200 bg-white p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-semibold text-stone-900">v{s.snapshotNo}</span>
                  <span className="ml-2 text-stone-500">{fmt(s.createdAt)}</span>
                  {s.note && (
                    <span className="ml-2 text-stone-700 italic">— {s.note}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void loadDiff(s.id)}
                    className="text-[11px] font-semibold text-violet-700 hover:text-violet-900"
                  >
                    {openDiffFor === s.id ? "Hide diff" : "Diff vs current"}
                  </button>
                  <button
                    onClick={() => void restore(s.id, s.snapshotNo)}
                    className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
                  >
                    Restore
                  </button>
                </div>
              </div>

              {openDiffFor === s.id && (
                <div className="mt-2 overflow-hidden rounded border border-stone-200">
                  {diffLoading && (
                    <div className="px-2 py-1 text-[11px] text-stone-500">Loading diff…</div>
                  )}
                  {!diffLoading && diff && Object.keys(diff).length === 0 && (
                    <div className="px-2 py-1 text-[11px] text-stone-500">
                      No section differences vs current draft.
                    </div>
                  )}
                  {!diffLoading &&
                    diff &&
                    Object.entries(diff).map(([section, body]) => (
                      <div key={section} className="border-t border-stone-100">
                        <div className="bg-stone-100 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-stone-700">
                          {section}
                        </div>
                        <div className="max-h-80 overflow-auto">
                          {body.split("\n").map((line, i) => (
                            <DiffLine key={i} line={line} />
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
