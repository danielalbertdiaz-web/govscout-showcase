"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Block = {
  id: string;
  key: string;
  title: string;
  version: number;
};

type Pin = {
  id: string;
  blockKey: string;
  pinnedVersion: number;
  insertedAt: number;
  positionHint: string | null;
};

type Stale = { pin: Pin; liveVersion: number };

const SECTIONS = [
  { key: "executive_summary", title: "Executive Summary" },
  { key: "capability_statement", title: "Capability Statement" },
  { key: "technical_approach", title: "Technical Approach" },
  { key: "past_performance", title: "Past Performance" },
  { key: "reviewer_notes", title: "Reviewer Notes" },
] as const;

export default function BoilerplatePicker({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [stale, setStale] = useState<Stale[]>([]);
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<string>("capability_statement");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [b, p] = await Promise.all([
          fetch("/api/boilerplate"),
          fetch(`/api/drafts/${draftId}/boilerplate`),
        ]);
        if (b.ok) {
          const data = (await b.json()) as { blocks: Block[] };
          if (alive) setBlocks(data.blocks);
        }
        if (p.ok) {
          const data = (await p.json()) as { pins: Pin[]; stale: Stale[] };
          if (alive) {
            setPins(data.pins);
            setStale(data.stale);
          }
        }
      } catch {
        // ignore
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [draftId]);

  const filtered = useMemo(() => {
    const ql = q.replace(/^\/insert\s*/, "").trim().toLowerCase();
    if (!ql) return blocks;
    return blocks.filter(
      (b) =>
        b.key.toLowerCase().includes(ql) || b.title.toLowerCase().includes(ql),
    );
  }, [blocks, q]);

  async function insert(blockKey: string) {
    setMsg(null);
    const r = await fetch(`/api/drafts/${draftId}/boilerplate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockKey, section: target }),
    });
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string };
      setMsg(`Insert failed: ${e.error ?? r.statusText}`);
      return;
    }
    const data = (await r.json()) as { block: { key: string; version: number } };
    setMsg(`Inserted ${data.block.key} v${data.block.version} → ${target}`);
    setQ("");
    router.refresh();
    // Refresh pins
    const p = await fetch(`/api/drafts/${draftId}/boilerplate`);
    if (p.ok) {
      const data2 = (await p.json()) as { pins: Pin[]; stale: Stale[] };
      setPins(data2.pins);
      setStale(data2.stale);
    }
    setTimeout(() => setMsg(null), 3000);
  }

  return (
    <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-amber-900">
          📋 Boilerplate insert ({blocks.length} blocks)
        </div>
        {msg && <span className="text-xs text-emerald-700">{msg}</span>}
      </header>

      {stale.length > 0 && (
        <div className="mt-2 rounded-md border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900">
          ⚠ {stale.length} pinned block{stale.length === 1 ? "" : "s"} {stale.length === 1 ? "has" : "have"} a newer
          version available:
          <ul className="mt-1 ml-4 list-disc">
            {stale.map((s) => (
              <li key={s.pin.id}>
                <code>{s.pin.blockKey}</code>: pinned v{s.pin.pinnedVersion}, live v{s.liveVersion}
                {" · "}
                <button
                  onClick={() => void insert(s.pin.blockKey)}
                  className="font-semibold text-rose-800 underline hover:text-rose-900"
                >
                  re-insert latest into {s.pin.positionHint ?? target}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="/insert <key>  or  search…"
          className="grow rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm focus:border-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-600/20"
        />
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="rounded-md border border-amber-300 bg-white px-2 py-1.5 text-xs"
        >
          {SECTIONS.map((s) => (
            <option key={s.key} value={s.key}>
              → {s.title}
            </option>
          ))}
        </select>
      </div>

      {q && (
        <ul className="mt-2 max-h-60 overflow-auto rounded-md border border-amber-200 bg-white">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-stone-500">No matches.</li>
          ) : (
            filtered.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between border-b border-amber-100 px-3 py-1.5 last:border-b-0 hover:bg-amber-50"
              >
                <div className="min-w-0">
                  <code className="text-[11px] font-mono text-stone-700">{b.key}</code>{" "}
                  <span className="text-[11px] text-stone-900">v{b.version}</span>
                  <div className="text-xs text-stone-700">{b.title}</div>
                </div>
                <button
                  onClick={() => void insert(b.key)}
                  className="ml-2 shrink-0 rounded-md border border-emerald-600 bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-700"
                >
                  Insert
                </button>
              </li>
            ))
          )}
        </ul>
      )}

      {pins.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-amber-900 hover:text-amber-700">
            Pinned in this draft ({pins.length})
          </summary>
          <ul className="mt-1 ml-4 list-disc text-[11px] text-stone-700">
            {pins.map((p) => (
              <li key={p.id}>
                <code>{p.blockKey}</code> v{p.pinnedVersion}
                {p.positionHint && <span className="text-stone-500"> → {p.positionHint}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
