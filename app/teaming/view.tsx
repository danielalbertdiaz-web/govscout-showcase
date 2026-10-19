"use client";

import { useMemo, useState } from "react";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";
import type { TeamingNoticeRecord } from "@/lib/db";
import {
  naicsLabel,
  TEAMING_DISPOSITIONS,
  TEAMING_DISPOSITION_LABELS,
  type TeamingDisposition,
} from "@/lib/teaming-sources/types";

type Props = {
  user: { email: string; name: string };
  initialNotices: TeamingNoticeRecord[];
  sourceConfigured: boolean;
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900 shadow-sm focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

const DISPOSITION_PILL: Record<TeamingDisposition, string> = {
  new: "border-sky-300 bg-sky-50 text-sky-800",
  pursuing: "border-amber-300 bg-amber-50 text-amber-800",
  outreach_drafted: "border-violet-300 bg-violet-50 text-violet-800",
  passed: "border-stone-300 bg-stone-100 text-stone-600",
  teamed: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-700";
  if (score >= 40) return "text-amber-700";
  return "text-stone-500";
}

export default function TeamingView({ user, initialNotices, sourceConfigured }: Props) {
  const [notices, setNotices] = useState<TeamingNoticeRecord[]>(initialNotices);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [dispFilter, setDispFilter] = useState<string>("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const filtered = useMemo(
    () => (dispFilter === "all" ? notices : notices.filter((n) => n.disposition === dispFilter)),
    [notices, dispFilter],
  );

  async function runScan() {
    setScanning(true);
    setScanMsg(null);
    try {
      const r = await fetch("/api/teaming", { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        setScanMsg(data?.error ? `Scan failed: ${data.error}` : "Scan failed.");
        return;
      }
      setNotices(data.notices ?? []);
      setScanMsg(
        data.available
          ? `Scan complete — ${data.found} found, ${data.persisted} saved.`
          : "No source configured (set SAM_GOV_API_KEY). Nothing to scan yet.",
      );
    } catch {
      setScanMsg("Scan failed (network).");
    } finally {
      setScanning(false);
    }
  }

  async function setDisposition(id: string, disposition: TeamingDisposition) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/teaming/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disposition }),
      });
      const data = await r.json();
      if (r.ok && data.notice) {
        setNotices((prev) => prev.map((n) => (n.id === id ? data.notice : n)));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function draftOutreach(id: string) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/teaming/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderName: "Acme Consulting" }),
      });
      const data = await r.json();
      if (r.ok) {
        setDrafts((prev) => ({ ...prev, [id]: data.draft }));
        if (data.notice) setNotices((prev) => prev.map((n) => (n.id === id ? data.notice : n)));
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Teaming"
        title={`${notices.length} subaward / teaming notice${notices.length === 1 ? "" : "s"}`}
        subtitle="SAM.gov Special-Notice / Sources-Sought postings where Acme Consulting could join as a sub. Discovered + scored only — nothing is sent."
        userLabel={user.name}
        activeNav="teaming"
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
        <PageInfo id="teaming" title="What is Teaming?">
          <p>
            Before an agency publishes a grant or contract, it often posts a <strong>Sources Sought</strong> or{" "}
            <strong>Special Notice</strong> — &ldquo;who out there can do this work?&rdquo; Responding early is how small firms get
            invited onto a bigger prime&rsquo;s team as a <strong>subcontractor</strong>, without having to win the whole award alone.
          </p>
          <p>
            This page scans SAM.gov for those notices in Acme&rsquo;s behavioral-health NAICS codes and scores each one for fit.
            <strong> Use it:</strong> hit <em>Scan now</em>, open a high scorer, and use <em>Draft outreach</em> to write the
            introduction note — it saves as a draft for you to send manually. Nothing ever sends itself.
          </p>
        </PageInfo>
        {!sourceConfigured && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
            <span className="font-semibold">SAM.gov source not configured.</span> Set{" "}
            <code className="rounded bg-amber-100 px-1">SAM_GOV_API_KEY</code> to enable live
            discovery. The lane, scoring, and weekly cron are wired and will light up once a key is
            present.
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
            <option value="all">All ({notices.length})</option>
            {TEAMING_DISPOSITIONS.map((d) => (
              <option key={d} value={d}>
                {TEAMING_DISPOSITION_LABELS[d]} ({notices.filter((n) => n.disposition === d).length})
              </option>
            ))}
          </select>
        </div>

        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-stone-300 px-4 py-10 text-center text-sm text-stone-500">
            No teaming notices yet. Click <span className="font-medium">Scan now</span> to discover
            them.
          </div>
        )}

        {filtered.map((n) => (
          <div key={n.id} className="rounded-lg border border-stone-300 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${DISPOSITION_PILL[n.disposition]}`}>
                    {TEAMING_DISPOSITION_LABELS[n.disposition]}
                  </span>
                  <span className="rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-600">
                    {n.noticeType}
                  </span>
                  {n.knownPrime && (
                    <span className="rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
                      Known prime
                    </span>
                  )}
                </div>
                <h3 className="mt-1.5 truncate text-sm font-semibold text-stone-900">
                  {n.url ? (
                    <a href={n.url} target="_blank" rel="noreferrer" className="hover:text-emerald-700 hover:underline">
                      {n.title}
                    </a>
                  ) : (
                    n.title
                  )}
                </h3>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-stone-500">
                  {n.agency && <span>{n.agency}</span>}
                  {n.prime && <span>Prime: {n.prime}</span>}
                  <span>NAICS {naicsLabel(n.naics)}</span>
                  {n.responseDeadline && <span>Respond by {n.responseDeadline}</span>}
                  {n.setAside && <span>{n.setAside}</span>}
                </div>
              </div>
              <div className={`shrink-0 text-right ${scoreColor(n.fitScore)}`}>
                <div className="text-2xl font-bold leading-none">{n.fitScore}</div>
                <div className="text-[10px] uppercase tracking-wide text-stone-400">fit</div>
              </div>
            </div>

            {n.reasons.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {n.reasons.map((r, i) => (
                  <li key={i} className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600">
                    {r}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                value={n.disposition}
                disabled={busyId === n.id}
                onChange={(e) => setDisposition(n.id, e.target.value as TeamingDisposition)}
                className={INPUT}
              >
                {TEAMING_DISPOSITIONS.map((d) => (
                  <option key={d} value={d}>
                    {TEAMING_DISPOSITION_LABELS[d]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => draftOutreach(n.id)}
                disabled={busyId === n.id}
                className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                {busyId === n.id ? "Working…" : "Draft outreach"}
              </button>
            </div>

            {(drafts[n.id] ?? n.outreachDraft) && (
              <div className="mt-3">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-stone-400">
                  Outreach draft — review &amp; send by hand (nothing sent)
                </div>
                <pre className="max-h-64 overflow-auto rounded-md border border-stone-200 bg-stone-50 p-3 text-xs leading-relaxed text-stone-700 whitespace-pre-wrap">
                  {drafts[n.id] ?? n.outreachDraft}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
