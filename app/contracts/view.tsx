"use client";

import { useMemo, useState } from "react";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";
import type { MicroContractRecord } from "@/lib/db";
import {
  MICRO_CONTRACT_DISPOSITIONS,
  MICRO_CONTRACT_DISPOSITION_LABELS,
  type MicroContractDisposition,
} from "@/lib/micro-contracts-types";
import { naicsLabel } from "@/lib/teaming-sources/types";

type Props = {
  user: { email: string; name: string };
  initialContracts: MicroContractRecord[];
  samConfigured: boolean;
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900 shadow-sm focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

const DISPOSITION_PILL: Record<MicroContractDisposition, string> = {
  new: "border-sky-300 bg-sky-50 text-sky-800",
  reviewing: "border-amber-300 bg-amber-50 text-amber-800",
  drafting: "border-violet-300 bg-violet-50 text-violet-800",
  submitted: "border-blue-300 bg-blue-50 text-blue-800",
  passed: "border-stone-300 bg-stone-100 text-stone-600",
  won: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

// DELIBERATE divergence from lib/deadline.ts (reviewed 2026-08-04, cleanup
// task 1) — this is a chosen dialect, not an accidental third copy:
//
// micro_contracts.response_deadline values are DATE-ONLY strings
// ("2026-08-05"). Date.parse puts those at midnight UTC, so lib/deadline's
// hour-based vocabulary would show "past due" for most of the local due day
// (an Eastern-time evening before the date has even arrived). The day-based
// ceil() here absorbs that, and "Due today"/"Due tomorrow" is the operative
// fact for short-fuse micro-purchases. "Expired" does not collide with any
// micro disposition, so the D-1 wording hazard does not apply.
//
// If micro deadlines ever gain time-of-day precision, revisit and unify.
function deadlineDaysLeft(deadline: string | null): number | null {
  if (!deadline) return null;
  const dl = new Date(deadline).getTime();
  if (isNaN(dl)) return null;
  return Math.ceil((dl - Date.now()) / (1000 * 60 * 60 * 24));
}

function deadlineColor(daysLeft: number | null): string {
  if (daysLeft === null) return "text-stone-500";
  if (daysLeft < 0) return "text-stone-400 line-through";
  if (daysLeft < 3) return "text-red-600 font-semibold";
  if (daysLeft < 7) return "text-amber-600 font-medium";
  return "text-emerald-700";
}

function deadlineLabel(deadline: string | null): string {
  const days = deadlineDaysLeft(deadline);
  if (days === null) return "No deadline";
  if (days < 0) return "Expired";
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `${days} days left`;
}

export default function ContractsView({ user, initialContracts, samConfigured }: Props) {
  const [contracts, setContracts] = useState<MicroContractRecord[]>(initialContracts);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [dispFilter, setDispFilter] = useState<string>("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(
    () => (dispFilter === "all" ? contracts : contracts.filter((c) => c.disposition === dispFilter)),
    [contracts, dispFilter],
  );

  async function runScan() {
    setScanning(true);
    setScanMsg(null);
    try {
      const r = await fetch("/api/micro-contracts/scan", { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        setScanMsg(data?.error ? `Scan failed: ${data.error}` : "Scan failed.");
        return;
      }
      setContracts(data.contracts ?? []);
      setScanMsg(
        data.available
          ? `Scan complete — ${data.found} found, ${data.newCount} new.`
          : "No SAM.gov API key configured. Set SAM_GOV_API_KEY to enable.",
      );
    } catch {
      setScanMsg("Scan failed (network).");
    } finally {
      setScanning(false);
    }
  }

  async function setDisposition(id: string, disposition: MicroContractDisposition) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/micro-contracts/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disposition }),
      });
      const data = await r.json();
      if (r.ok && data.contract) {
        setContracts((prev) => prev.map((c) => (c.id === id ? data.contract : c)));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function draftResponse(id: string) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/micro-contracts/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const data = await r.json();
      if (r.ok) {
        setDrafts((prev) => ({ ...prev, [id]: data.draft }));
        if (data.contract) setContracts((prev) => prev.map((c) => (c.id === id ? data.contract : c)));
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Contracts"
        title={`${contracts.length} micro contract${contracts.length === 1 ? "" : "s"}`}
        subtitle="SAM.gov solicitations and combined synopsis/solicitations in Acme Consulting's NAICS codes. Scanned, not sent."
        userLabel={user.name}
        activeNav="contracts"
        trailingActions={
          <button
            type="button"
            onClick={runScan}
            disabled={scanning}
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan now"}
          </button>
        }
      />

      <div className="mt-4 flex flex-col gap-4">
        <PageInfo id="micro-contracts" title="What are Micro Contracts?">
          <p>
            Federal micro-purchases and small contracts (typically under $250K) are the fastest path to building{" "}
            <strong>past performance</strong> for 8(a) certification. This page scans SAM.gov for{" "}
            <strong>solicitations</strong> and <strong>combined synopsis/solicitations</strong> in your core NAICS
            codes (541611, 541512, 541519, 541715) and filters for eligible set-asides.
          </p>
          <p>
            <strong>Use it:</strong> hit <em>Scan now</em>, review opportunities sorted by deadline, and click{" "}
            <em>Draft Response</em> to auto-generate a capability statement. Apply directly on SAM.gov via the link.
          </p>
        </PageInfo>

        {!samConfigured && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
            <span className="font-semibold">SAM.gov source not configured.</span> Set{" "}
            <code className="rounded bg-amber-100 px-1">SAM_GOV_API_KEY</code> to enable live scanning.
          </div>
        )}

        {scanMsg && (
          <div className="rounded-lg border border-stone-300 bg-stone-50 px-4 py-2.5 text-xs text-stone-600">
            {scanMsg}
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-stone-600">
          <span>Filter:</span>
          <select value={dispFilter} onChange={(e) => setDispFilter(e.target.value)} className={INPUT}>
            <option value="all">All ({contracts.length})</option>
            {MICRO_CONTRACT_DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {MICRO_CONTRACT_DISPOSITION_LABELS[d]} ({contracts.filter((c) => c.disposition === d).length})
              </option>
            ))}
          </select>
        </div>

        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-stone-300 px-4 py-10 text-center text-sm text-stone-500">
            No micro contracts yet. Click <span className="font-medium">Scan now</span> to discover them.
          </div>
        )}

        {/* Table header */}
        {filtered.length > 0 && (
          <div className="hidden rounded-t-lg border border-stone-200 bg-stone-50 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-stone-500 sm:grid sm:grid-cols-12 sm:gap-2">
            <div className="col-span-4">Title</div>
            <div className="col-span-2">Agency</div>
            <div className="col-span-1">NAICS</div>
            <div className="col-span-1">Set-Aside</div>
            <div className="col-span-2">Deadline</div>
            <div className="col-span-2">Actions</div>
          </div>
        )}

        {filtered.map((c) => {
          const daysLeft = deadlineDaysLeft(c.responseDeadline);
          const dlColor = deadlineColor(daysLeft);
          const urgentBorder =
            daysLeft !== null && daysLeft >= 0 && daysLeft < 3
              ? "border-red-300"
              : daysLeft !== null && daysLeft >= 0 && daysLeft < 7
                ? "border-amber-300"
                : "border-stone-200";

          return (
            <div key={c.id} className={`rounded-lg border bg-white p-4 shadow-sm ${urgentBorder}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${DISPOSITION_PILL[c.disposition]}`}>
                      {MICRO_CONTRACT_DISPOSITION_LABELS[c.disposition]}
                    </span>
                    <span className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-600">
                      {c.noticeType}
                    </span>
                    {c.setAside && (
                      <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
                        {c.setAside}
                      </span>
                    )}
                  </div>
                  <h3 className="mt-1.5 text-sm font-semibold text-stone-900">
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" className="hover:text-emerald-700 hover:underline">
                        {c.title}
                      </a>
                    ) : (
                      c.title
                    )}
                  </h3>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-stone-500">
                    {c.agency && <span>{c.agency}</span>}
                    {c.solNumber && <span>Sol# {c.solNumber}</span>}
                    <span>NAICS {naicsLabel(c.naics)}</span>
                  </div>
                </div>
                <div className={`shrink-0 text-right ${dlColor}`}>
                  <div className="text-sm font-medium leading-tight">{deadlineLabel(c.responseDeadline)}</div>
                  {c.responseDeadline && (
                    <div className="text-[10px] text-stone-400">{c.responseDeadline}</div>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  value={c.disposition}
                  disabled={busyId === c.id}
                  onChange={(e) => setDisposition(c.id, e.target.value as MicroContractDisposition)}
                  className={INPUT}
                >
                  {MICRO_CONTRACT_DISPOSITIONS.map((d) => (
                    <option key={d} value={d}>
                      {MICRO_CONTRACT_DISPOSITION_LABELS[d]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => draftResponse(c.id)}
                  disabled={busyId === c.id}
                  className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                >
                  {busyId === c.id ? "Drafting…" : "Draft Response"}
                </button>
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                  >
                    Apply on SAM.gov
                  </a>
                )}
              </div>

              {(drafts[c.id] ?? c.responseDraft) && (
                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-stone-400">
                    Response draft — review before submitting (nothing sent)
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-md border border-stone-200 bg-stone-50 p-3 text-xs leading-relaxed text-stone-700 whitespace-pre-wrap">
                    {drafts[c.id] ?? c.responseDraft}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
