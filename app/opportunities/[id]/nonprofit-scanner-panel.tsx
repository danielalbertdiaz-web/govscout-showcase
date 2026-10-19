"use client";

// Item 4.5 — non-profit partner-discovery panel on the opportunity page.
// Shows the persisted, ranked candidate non-profits (ProPublica/IRS-990 live),
// lets the operator run/refresh a scan, set a triage disposition, and promote a
// candidate into a 4.3 contact LEAD. NOTHING is sent — promotion only creates a
// reviewable contact record.

import { useEffect, useState } from "react";

type Candidate = {
  id: string;
  ein: string | null;
  name: string;
  nteeCode: string | null;
  state: string | null;
  source: string;
  sourceUrl: string | null;
  revenueUsd: number | null;
  relevanceScore: number;
  reasons: string[];
  themes: string[];
  disposition: "new" | "already_contacted" | "not_interested" | "partnered";
  promotedContactId: string | null;
};

type ListResp = { candidates: Candidate[]; themes: string[] };
type ScanResp = ListResp & {
  scanned: boolean;
  sourcesUsed: string[];
  found: number;
  ranked: number;
  error?: string;
  message?: string;
};

const DISPOSITIONS: { value: Candidate["disposition"]; label: string }[] = [
  { value: "new", label: "New" },
  { value: "already_contacted", label: "Already contacted" },
  { value: "not_interested", label: "Not interested" },
  { value: "partnered", label: "Partnered" },
];

const DISP_STYLE: Record<Candidate["disposition"], string> = {
  new: "bg-sky-100 text-sky-900 border-sky-300",
  already_contacted: "bg-amber-100 text-amber-900 border-amber-300",
  not_interested: "bg-stone-200 text-stone-600 border-stone-300",
  partnered: "bg-emerald-100 text-emerald-900 border-emerald-300",
};

function scoreColor(s: number): string {
  if (s >= 60) return "text-emerald-700";
  if (s >= 40) return "text-amber-700";
  return "text-stone-500";
}

function money(n: number | null): string | null {
  if (n == null) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export default function NonprofitScannerPanel({ opportunityId }: { opportunityId: string }) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/opportunities/${opportunityId}/scan-nonprofits`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as ListResp;
        if (alive) {
          setCandidates(json.candidates);
          setThemes(json.themes);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [opportunityId]);

  async function runScan() {
    setScanning(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/scan-nonprofits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as ScanResp;
      if (!res.ok) {
        setNote(json.message ?? json.error ?? "scan failed");
        if (json.candidates) setCandidates(json.candidates);
        return;
      }
      setCandidates(json.candidates);
      setThemes(json.themes);
      setNote(
        `Scanned ${json.sourcesUsed.join(", ")} · ${json.found} found · ${json.ranked} new ranked.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function setDisposition(id: string, disposition: Candidate["disposition"]) {
    setBusy(id);
    try {
      const res = await fetch(
        `/api/opportunities/${opportunityId}/scan-nonprofits/${id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disposition }),
        },
      );
      const json = (await res.json()) as { candidate?: Candidate; error?: string };
      if (!res.ok || !json.candidate) throw new Error(json.error ?? "failed");
      setCandidates((prev) => prev.map((c) => (c.id === id ? json.candidate! : c)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to update");
    } finally {
      setBusy(null);
    }
  }

  async function promote(id: string) {
    setBusy(id);
    try {
      const res = await fetch(
        `/api/opportunities/${opportunityId}/scan-nonprofits/${id}`,
        { method: "POST" },
      );
      const json = (await res.json()) as { candidate?: Candidate; error?: string };
      if (!res.ok || !json.candidate) throw new Error(json.error ?? "failed");
      setCandidates((prev) => prev.map((c) => (c.id === id ? json.candidate! : c)));
      setNote("Added as a contact lead (draft only — nothing sent).");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to promote");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-600">
          Non-profit partners
        </h2>
        <button
          onClick={runScan}
          disabled={scanning}
          className="rounded-md border border-stone-300 bg-white px-3 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : candidates.length ? "Re-scan" : "Run scan"}
        </button>
      </div>

      <p className="mt-1 text-xs text-stone-500">
        Free IRS-990 / ProPublica discovery, biased to NJ/FL.{" "}
        {themes.length > 0 ? `Themes: ${themes.join(", ")}.` : "No theme inferred yet."}
      </p>

      {note && <p className="mt-2 rounded-md bg-stone-50 p-2 text-xs text-stone-600">{note}</p>}
      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      {loading ? (
        <p className="mt-4 text-sm text-stone-500">Loading…</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {candidates.map((c, i) => (
            <li
              key={c.id}
              className={`rounded-lg border p-3 ${i === 0 ? "border-emerald-200 bg-emerald-50/30" : "border-stone-200"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-stone-800">{c.name}</span>
                    {c.state && (
                      <span className="text-[11px] uppercase tracking-wide text-stone-400">
                        {c.state}
                      </span>
                    )}
                    {c.nteeCode && (
                      <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-mono text-stone-500">
                        {c.nteeCode}
                      </span>
                    )}
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${DISP_STYLE[c.disposition]}`}
                    >
                      {DISPOSITIONS.find((d) => d.value === c.disposition)?.label}
                    </span>
                  </div>
                  {money(c.revenueUsd) && (
                    <span className="text-[11px] text-stone-500">Revenue ≈ {money(c.revenueUsd)}</span>
                  )}
                </div>
                <span className={`text-lg font-bold tabular-nums ${scoreColor(c.relevanceScore)}`}>
                  {c.relevanceScore}
                  <span className="text-xs font-normal text-stone-400">/100</span>
                </span>
              </div>

              {c.reasons.length > 0 && (
                <ul className="mt-2 flex flex-col gap-0.5">
                  {c.reasons.map((r, j) => (
                    <li key={j} className="text-xs text-stone-600">
                      · {r}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={c.disposition}
                  disabled={busy === c.id}
                  onChange={(e) => setDisposition(c.id, e.target.value as Candidate["disposition"])}
                  className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 disabled:opacity-50"
                >
                  {DISPOSITIONS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>

                {c.promotedContactId ? (
                  <span className="text-[11px] text-emerald-700">✓ Added as lead</span>
                ) : (
                  <button
                    onClick={() => promote(c.id)}
                    disabled={busy === c.id}
                    className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                  >
                    {busy === c.id ? "…" : "Add as lead"}
                  </button>
                )}

                {c.sourceUrl && (
                  <a
                    href={c.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-sky-700 underline hover:text-sky-900"
                  >
                    IRS 990 ↗
                  </a>
                )}
              </div>
            </li>
          ))}
          {candidates.length === 0 && (
            <li className="text-xs text-stone-500">
              No candidates yet. Run a scan to discover NJ/FL non-profits aligned with this
              opportunity.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
