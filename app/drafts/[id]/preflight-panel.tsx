"use client";

import { useCallback, useEffect, useState } from "react";

type Severity = "green" | "yellow" | "red";

type CheckResult = {
  id: string;
  label: string;
  severity: Severity;
  message: string;
  ruleNote?: string;
};

type PreflightResult = {
  ranAt: number;
  results: CheckResult[];
  redCount: number;
  yellowCount: number;
  greenCount: number;
  canSubmit: boolean;
};

type DraftStatusInfo = {
  status: "drafting" | "auto_drafted" | "submitted" | "won" | "lost";
  updatedAt: number | null;
  preflightAt: number | null;
  override: string | null;
};

const PRE_SUBMIT_STATUSES = new Set<DraftStatusInfo["status"]>(["drafting", "auto_drafted"]);

const SEV_COLOR: Record<Severity, string> = {
  green: "border-emerald-300 bg-emerald-50 text-emerald-900",
  yellow: "border-amber-300 bg-amber-50 text-amber-900",
  red: "border-rose-400 bg-rose-50 text-rose-900",
};

function fmt(ts: number) {
  return new Date(ts).toLocaleString();
}

export default function PreflightPanel({ draftId }: { draftId: string }) {
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [status, setStatus] = useState<DraftStatusInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideConfirm, setOverrideConfirm] = useState("");

  const loadStatus = useCallback(async () => {
    const r = await fetch(`/api/drafts/${draftId}/status`);
    if (r.ok) {
      const data = (await r.json()) as DraftStatusInfo;
      setStatus(data);
    }
  }, [draftId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadStatus]);

  async function runCheck() {
    setRunning(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/drafts/${draftId}/preflight`, { method: "POST" });
      if (!r.ok) {
        setMsg(`Pre-flight failed (${r.statusText})`);
        return;
      }
      const data = (await r.json()) as PreflightResult;
      setResult(data);
    } finally {
      setRunning(false);
    }
  }

  async function submit() {
    setMsg(null);
    const r = await fetch(`/api/drafts/${draftId}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "submitted",
        override: overriding && overrideReason.trim() ? overrideReason.trim() : undefined,
        overrideConfirm: overriding ? overrideConfirm.trim() : undefined,
      }),
    });
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as {
        error?: string;
        redCount?: number;
        instruction?: string;
      };
      if (e.error === "preflight_blocks_submission") {
        setOverriding(true);
        setMsg(`Pre-flight blocks submission (${e.redCount} red). ${e.instruction}`);
      } else {
        setMsg(`Submit failed: ${e.error ?? r.statusText}`);
      }
      // Auto-refresh result on block
      void runCheck();
      return;
    }
    const data = (await r.json()) as { status: string; overridden?: boolean };
    setMsg(data.overridden ? "Submitted (with override)." : "Submitted ✓");
    setOverriding(false);
    setOverrideReason("");
    setOverrideConfirm("");
    void loadStatus();
  }

  async function unsubmit(target: "drafting" | "auto_drafted" | "won" | "lost") {
    setMsg(null);
    const r = await fetch(`/api/drafts/${draftId}/status`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: target }),
    });
    if (r.ok) {
      setMsg(`Moved to ${target}.`);
      void loadStatus();
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/30 p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-emerald-900">
            🛡 Pre-submission checklist
          </div>
          {status && (
            <div className="mt-0.5 text-[11px] text-stone-600">
              Status: <span className="font-semibold">{status.status}</span>
              {status.updatedAt && <span> · changed {fmt(status.updatedAt)}</span>}
              {status.override && (
                <div className="mt-0.5 italic text-amber-700">Override: {status.override}</div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void runCheck()}
            disabled={running}
            className="rounded-md border border-emerald-700 bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {running ? "Running…" : "Run pre-flight"}
          </button>
          {status && PRE_SUBMIT_STATUSES.has(status.status) && result && (
            <button
              onClick={() => void submit()}
              className={`rounded-md border px-3 py-1 text-xs font-semibold text-white ${
                result.canSubmit
                  ? "border-emerald-800 bg-emerald-700 hover:bg-emerald-800"
                  : "border-rose-700 bg-rose-700 hover:bg-rose-800"
              }`}
            >
              {result.canSubmit ? "Mark submitted" : "Override + submit"}
            </button>
          )}
          {status?.status === "submitted" && (
            <>
              <button
                onClick={() => void unsubmit("won")}
                className="rounded-md border border-emerald-700 bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Mark won
              </button>
              <button
                onClick={() => void unsubmit("lost")}
                className="rounded-md border border-stone-500 bg-stone-200 px-3 py-1 text-xs font-semibold text-stone-800 hover:bg-stone-300"
              >
                Mark lost
              </button>
              <button
                onClick={() => void unsubmit("drafting")}
                className="rounded-md border border-amber-500 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-200"
              >
                Back to drafting
              </button>
            </>
          )}
        </div>
      </header>

      {msg && (
        <div className="mt-2 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-900">
          {msg}
        </div>
      )}

      {overriding && (
        <div className="mt-2 rounded-md border border-rose-400 bg-rose-50 p-2 text-xs text-rose-900">
          <div className="mb-1 font-semibold">
            ⚠ Override pre-flight block
          </div>
          <input
            type="text"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            placeholder="Reason for overriding (required)"
            className="block w-full rounded border border-rose-300 bg-white px-2 py-1 text-xs"
          />
          <input
            type="text"
            value={overrideConfirm}
            onChange={(e) => setOverrideConfirm(e.target.value)}
            placeholder='Type exactly: I KNOW WHAT I AM DOING'
            className="mt-1 block w-full rounded border border-rose-300 bg-white px-2 py-1 text-xs"
          />
          <button
            onClick={() => void submit()}
            className="mt-1 rounded border border-rose-700 bg-rose-700 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-800"
          >
            Override + submit
          </button>
        </div>
      )}

      {result && (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-3 text-xs">
            <span className={`rounded-full border px-2 py-0.5 font-semibold ${SEV_COLOR.green}`}>
              {result.greenCount} green
            </span>
            <span className={`rounded-full border px-2 py-0.5 font-semibold ${SEV_COLOR.yellow}`}>
              {result.yellowCount} yellow
            </span>
            <span className={`rounded-full border px-2 py-0.5 font-semibold ${SEV_COLOR.red}`}>
              {result.redCount} red
            </span>
            <span className="text-stone-500">· ran {fmt(result.ranAt)}</span>
          </div>
          <ul className="space-y-1">
            {result.results.map((r) => (
              <li
                key={r.id}
                className={`rounded-md border px-2 py-1.5 text-xs ${SEV_COLOR[r.severity]}`}
              >
                <div className="font-semibold">
                  {r.severity === "red" && "🛑 "}
                  {r.severity === "yellow" && "⚠️ "}
                  {r.severity === "green" && "✓ "}
                  {r.label}
                </div>
                <div>{r.message}</div>
                {r.ruleNote && (
                  <div className="mt-0.5 text-[10px] italic opacity-80">{r.ruleNote}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
