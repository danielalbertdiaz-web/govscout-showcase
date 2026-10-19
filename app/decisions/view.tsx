"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

type Decision = {
  id: string;
  createdAt: number;
  question: string;
  contextType: string | null;
  contextId: string | null;
  options: string[];
  recommendedOption: string | null;
  recommendedReason: string | null;
  deadlineMs: number | null;
  status: "open" | "decided" | "deferred" | "dismissed";
  decidedAt: number | null;
  decision: string | null;
  decisionNote: string | null;
  actionKind: string | null;
  actionStatus: string | null;
};

function fmt(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function contextLink(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case "draft": return `/drafts/${id}`;
    case "pool": return `/pools/${id}`;
    case "scout": return `/scouts/${id}`;
    case "partner": return `/partners/${id}`;
    default: return null;
  }
}

const STATUS_PILL: Record<Decision["status"], string> = {
  open: "border-rose-400 bg-rose-50 text-rose-900",
  decided: "border-emerald-500 bg-emerald-600 text-white",
  deferred: "border-amber-300 bg-amber-50 text-amber-900",
  dismissed: "border-stone-400 bg-stone-200 text-stone-700",
};

export default function DecisionsView({ initial }: { initial: Decision[] }) {
  const [items, setItems] = useState<Decision[]>(initial);
  const [filter, setFilter] = useState<"open" | "all" | Decision["status"]>("open");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((i) => i.status === filter);
  }, [items, filter]);

  async function resolve(
    id: string,
    status: "decided" | "deferred" | "dismissed",
    decision?: string,
  ) {
    const r = await fetch(`/api/decisions/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        decision: decision ?? null,
        decisionNote: noteFor === id ? noteText.trim() || null : null,
      }),
    });
    if (r.ok) {
      const data = (await r.json()) as { decision: Decision };
      setItems((s) => s.map((x) => (x.id === id ? data.decision : x)));
      setNoteFor(null);
      setNoteText("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {(["open", "decided", "deferred", "dismissed", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              filter === f
                ? "border-emerald-600 bg-emerald-600 text-white"
                : "border-stone-300 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {f === "all" ? `All (${items.length})` : `${f} (${items.filter((i) => i.status === f).length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-sm text-stone-500">
          {filter === "open"
            ? "No decisions waiting. Nice."
            : "No decisions match this filter."}
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((d) => {
            const link = contextLink(d.contextType, d.contextId);
            return (
              <li
                key={d.id}
                className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm"
              >
                <header className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-stone-900">{d.question}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
                      <span>Filed {fmt(d.createdAt)}</span>
                      {d.deadlineMs && <span>· Due {fmt(d.deadlineMs)}</span>}
                      {link && (
                        <>
                          <span>·</span>
                          <Link
                            href={link}
                            className="font-semibold text-emerald-700 hover:text-emerald-900"
                          >
                            {d.contextType}:{d.contextId?.slice(0, 8)} ↗
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL[d.status]}`}
                  >
                    {d.status}
                  </span>
                </header>

                {d.recommendedOption && (
                  <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
                    <div className="font-semibold">Alfred recommends: {d.recommendedOption}</div>
                    {d.recommendedReason && (
                      <div className="mt-1 italic">{d.recommendedReason}</div>
                    )}
                  </div>
                )}

                {d.status === "open" ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex flex-wrap gap-2">
                      {d.options.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => void resolve(d.id, "decided", opt)}
                          className={`rounded-md border px-3 py-1 text-xs font-semibold ${
                            opt === d.recommendedOption
                              ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
                              : "border-stone-400 bg-white text-stone-800 hover:bg-stone-50"
                          }`}
                        >
                          {opt === d.recommendedOption ? `✓ ${opt}` : opt}
                        </button>
                      ))}
                      <button
                        onClick={() => void resolve(d.id, "deferred")}
                        className="rounded-md border border-amber-400 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                      >
                        Defer
                      </button>
                      <button
                        onClick={() => void resolve(d.id, "dismissed")}
                        className="rounded-md border border-stone-400 bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-200"
                      >
                        Dismiss
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setNoteFor(noteFor === d.id ? null : d.id)}
                        className="text-[11px] text-stone-600 hover:text-stone-900"
                      >
                        {noteFor === d.id ? "Hide note" : "Add note"}
                      </button>
                      {noteFor === d.id && (
                        <input
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          placeholder="Optional reasoning…"
                          className="grow rounded-md border border-stone-300 bg-white px-2 py-1 text-xs"
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-stone-700">
                    {d.decision && (
                      <div>
                        <span className="font-semibold">Decision:</span> {d.decision}
                      </div>
                    )}
                    {d.decisionNote && (
                      <div className="mt-1 italic text-stone-600">{d.decisionNote}</div>
                    )}
                    {d.actionStatus && d.actionStatus !== "skipped" && (
                      <div className="mt-1 text-[11px] text-stone-500">
                        Side-effect: {d.actionKind} ({d.actionStatus})
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
