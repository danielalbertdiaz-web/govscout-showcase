"use client";

// Two-step delete for an OpenClaw cron job — the one scheduler write GovScout
// is allowed (OPERATIONS.md § Scheduling exception, 2026-08-26). Inline
// arm-then-confirm instead of window.confirm: an explicit second click with
// the job's own name in view, and no browser-modal side effects.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeleteCronButton({ jobId, jobName }: { jobId: string; jobName: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cron/jobs/${jobId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `delete failed (${res.status})`);
        setArmed(false);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setArmed(false);
    } finally {
      setBusy(false);
    }
  }

  if (!armed) {
    return (
      <span>
        <button
          onClick={() => setArmed(true)}
          className="rounded border border-stone-300 bg-white px-2 py-0.5 text-[11px] font-medium text-stone-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
          title={`Delete the "${jobName}" cron job permanently`}
        >
          Delete
        </button>
        {error && <span className="ml-2 text-[11px] text-rose-600">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        disabled={busy}
        onClick={() => void doDelete()}
        className="rounded bg-rose-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-rose-700 disabled:opacity-40"
      >
        {busy ? "Deleting…" : "Confirm delete"}
      </button>
      <button
        disabled={busy}
        onClick={() => setArmed(false)}
        className="rounded border border-stone-300 px-2 py-0.5 text-[11px] text-stone-500"
      >
        Cancel
      </button>
    </span>
  );
}
