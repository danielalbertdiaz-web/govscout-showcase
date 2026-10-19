"use client";

// P3 — collapsible "What is this page?" explainer. Every pipeline page gets
// one so the system explains itself instead of needing the manual open.
// Collapsed state persists per page in localStorage.

import { useEffect, useState } from "react";

type Props = {
  /** Stable per-page key, e.g. "teaming". */
  id: string;
  title: string;
  children: React.ReactNode;
};

export function PageInfo({ id, title, children }: Props) {
  const storageKey = `gs_pageinfo_${id}`;
  const [open, setOpen] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe localStorage hydration on mount
    setOpen(window.localStorage.getItem(storageKey) !== "closed");
    setHydrated(true);
  }, [storageKey]);

  function toggle() {
    const next = !open;
    setOpen(next);
    window.localStorage.setItem(storageKey, next ? "open" : "closed");
  }

  if (!hydrated) return null;

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 text-sm">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-800">
          {title}
        </span>
        <span className="text-xs text-sky-700">{open ? "Hide" : "What is this?"}</span>
      </button>
      {open && <div className="mt-2 space-y-1.5 leading-6 text-stone-700">{children}</div>}
    </div>
  );
}
