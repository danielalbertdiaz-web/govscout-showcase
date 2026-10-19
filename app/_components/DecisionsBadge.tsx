"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function DecisionsBadge() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/decisions?status=open");
        if (!r.ok) return;
        const data = (await r.json()) as { decisions: Array<unknown> };
        if (alive) setCount(data.decisions.length);
      } catch {
        // ignore
      }
    }
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!count) return null;
  return (
    <Link
      href="/decisions"
      className="gs-chip gs-chip-cta rounded-md border border-rose-400 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-900 hover:bg-rose-100"
      title={`${count} decision${count === 1 ? "" : "s"} waiting`}
    >
      ● {count} decision{count === 1 ? "" : "s"} waiting
    </Link>
  );
}
