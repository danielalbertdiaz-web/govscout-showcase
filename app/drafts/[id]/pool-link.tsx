"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type PoolOption = { id: string; name: string };

type Props = {
  draftId: string;
  currentPoolId: string | null;
};

export default function PoolLinkChooser({ draftId, currentPoolId }: Props) {
  const router = useRouter();
  const [pools, setPools] = useState<PoolOption[]>([]);
  const [selected, setSelected] = useState<string>(currentPoolId ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/pools?limit=200");
        const data = (await res.json()) as { pools?: PoolOption[] };
        if (!cancelled && Array.isArray(data.pools)) {
          setPools(data.pools.map((p) => ({ id: p.id, name: p.name })));
        }
      } catch {
        // ignore — loader pill stays empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function commit(next: string) {
    setSelected(next);
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poolId: next || null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(data.error ?? `Save failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <label className="text-[11px] text-stone-500">Link pool:</label>
      <select
        value={selected}
        onChange={(e) => void commit(e.target.value)}
        disabled={saving}
        className="rounded-md border border-stone-300 bg-white px-2 py-0.5 text-[11px] text-stone-700 shadow-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600/30 disabled:opacity-50"
      >
        <option value="">— none —</option>
        {pools.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {err && <span className="text-[11px] text-red-700">{err}</span>}
    </span>
  );
}
