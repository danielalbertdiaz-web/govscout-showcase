"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";
import { SuggestionInbox } from "@/app/_components/SuggestionInbox";
import { SCOUT_CRON_JOBS } from "@/lib/scouts-types";
import FoundationsPanel from "./foundations-panel";
import { ScoutProfilesPanel } from "./profiles-panel";

export type DigestListItem = {
  id: string;
  cronJobId: string;
  sourceLabel: string;
  ranAtMs: number;
  status: string | null;
  summaryPreview: string;
  itemCount: number;
  interestedCount: number;
  newCount: number;
};

type Props = {
  user: { email: string; name: string };
  initial: DigestListItem[];
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

function fmtDateTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Loading skeleton for scout digests
function ScoutsSkeleton() {
  return (
    <>
      {[...Array(8)].map((_, i) => (
        <div key={i} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="animate-pulse">
            <div className="flex items-start justify-between">
              <div className="space-y-2 flex-1">
                <div className="h-4 bg-stone-200 rounded w-1/3"></div>
                <div className="h-3 bg-stone-100 rounded w-1/4"></div>
              </div>
              <div className="h-6 bg-stone-100 rounded w-16"></div>
            </div>
            <div className="mt-3">
              <div className="h-3 bg-stone-100 rounded w-full"></div>
              <div className="h-3 bg-stone-100 rounded w-3/4 mt-1"></div>
            </div>
            <div className="mt-3 flex items-center gap-4">
              <div className="h-3 bg-stone-100 rounded w-20"></div>
              <div className="h-3 bg-stone-100 rounded w-20"></div>
              <div className="h-3 bg-stone-100 rounded w-20"></div>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function ScoutsView({ user, initial }: Props) {
  const router = useRouter();
  const [items] = useState<DigestListItem[]>(initial);
  const [q, setQ] = useState("");
  const [jobFilter, setJobFilter] = useState<string>("all");
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [apifyRunning, setApifyRunning] = useState(false);
  const [apifyMsg, setApifyMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((d) => {
      if (jobFilter !== "all" && d.cronJobId !== jobFilter) return false;
      if (!ql) return true;
      return (
        d.sourceLabel.toLowerCase().includes(ql) ||
        d.summaryPreview.toLowerCase().includes(ql)
      );
    });
  }, [items, q, jobFilter]);

  // P2 — the on-demand discovery rail: every scanner, one click.
  async function runAllScans() {
    setRunningAll(true);
    setIngestMsg(null);
    try {
      const res = await fetch("/api/scouts/run-all", { method: "POST" });
      const data = (await res.json()) as { lanes?: { lane: string; ok: boolean; detail: string }[]; error?: string };
      if (!res.ok || !data.lanes) {
        setIngestMsg(`Scan failed: ${data.error ?? res.statusText}`);
      } else {
        setIngestMsg(
          data.lanes.map((l) => `${l.ok ? "✓" : "✗"} ${l.lane}: ${l.detail}`).join("  ·  "),
        );
        router.refresh();
      }
    } catch (err) {
      setIngestMsg(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunningAll(false);
    }
  }

  async function pullIngest() {
    setIngesting(true);
    setLoading(true);
    setIngestMsg(null);
    try {
      const res = await fetch("/api/scouts/ingest", { method: "POST" });
      const data = (await res.json()) as {
        scanned: number;
        newDigests: number;
        newItems: number;
        skippedExisting: number;
        errors: string[];
      };
      if (!res.ok) {
        setIngestMsg(`Pull failed: ${(data as unknown as { error?: string }).error ?? res.statusText}`);
      } else if (data.newDigests === 0) {
        setIngestMsg(
          `No new digests. Scanned ${data.scanned} cron runs, ${data.skippedExisting} already in library.`,
        );
      } else {
        setIngestMsg(
          `Ingested ${data.newDigests} new digest${data.newDigests === 1 ? "" : "s"} (${data.newItems} item${data.newItems === 1 ? "" : "s"}).`,
        );
        router.refresh();
      }
    } catch (err) {
      setIngestMsg(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIngesting(false);
      setLoading(false);
    }
  }

  async function runApifyScrape() {
    setApifyRunning(true);
    setLoading(true);
    setApifyMsg(null);
    try {
      const res = await fetch("/api/scouts/apify-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ family: "all" }),
      });
      const data = (await res.json()) as
        | { error: string; instruction?: string }
        | {
            results: Array<{
              family: string;
              ok: boolean;
              newItems: number;
              skippedDedup: number;
              blockedTargets: string[];
              costUsd: number;
              apifyStatus: string;
              error: string | null;
            }>;
            totals: { newItems: number; skippedDedup: number; blockedTargetCount: number; costUsd: number };
          };
      if (!res.ok || "error" in data) {
        const e = data as { error: string; instruction?: string };
        setApifyMsg(`Apify run failed: ${e.error}${e.instruction ? ` — ${e.instruction}` : ""}`);
        return;
      }
      const lines = data.results.map(
        (r) =>
          `${r.family}: ${r.ok ? "✓" : "✗"} new=${r.newItems} dedup=${r.skippedDedup}` +
          (r.blockedTargets.length ? ` blocked=${r.blockedTargets.length}` : "") +
          ` ($${r.costUsd.toFixed(3)})` +
          (r.error ? ` err=${r.error}` : ""),
      );
      setApifyMsg(
        `Apify done — total new ${data.totals.newItems}, dedup ${data.totals.skippedDedup}, cost $${data.totals.costUsd.toFixed(3)}.\n${lines.join("\n")}`,
      );
      if (data.totals.newItems > 0) router.refresh();
    } catch (err) {
      setApifyMsg(`Apify run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApifyRunning(false);
      setLoading(false);
    }
  }

  const counts = useMemo(() => {
    const totalItems = items.reduce((acc, d) => acc + d.itemCount, 0);
    const totalNew = items.reduce((acc, d) => acc + d.newCount, 0);
    const totalInterested = items.reduce((acc, d) => acc + d.interestedCount, 0);
    return { totalItems, totalNew, totalInterested };
  }, [items]);

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Scouts"
        title={`${items.length} digest${items.length === 1 ? "" : "s"} captured`}
        subtitle="The discovery inbox — every scanner files what it finds here for triage."
        userLabel={user.name}
        activeNav="scouts"
        trailingActions={
          <>
            <button
              onClick={() => void runAllScans()}
              disabled={runningAll}
              title="Foundations + non-profits, SAM.gov teaming, unspent balances, settlement boards"
              className="rounded-md bg-emerald-700 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
            >
              {runningAll ? "Scanning all lanes…" : "Run all scans"}
            </button>
            <button
              onClick={() => void pullIngest()}
              disabled={ingesting}
              className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              {ingesting ? "Pulling…" : "Pull latest digests"}
            </button>
            <button
              onClick={() => void runApifyScrape()}
              disabled={apifyRunning}
              title="Apify foundation + lead-portal scrape (free tier; $1.25 cap per run)"
              className="rounded-md border border-sky-600 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
            >
              {apifyRunning ? "Scraping…" : "Run weekly scrape now"}
            </button>
          </>
        }
      />

      <div className="mt-4 flex flex-col gap-4">
        <PageInfo id="scouts" title="How do Scouts run?">
          <p>
            Scouts is the <strong>discovery inbox</strong>. Four scanner lanes file what they find here and in Pools:
            <strong> Foundations &amp; non-profits</strong> (PND announcements, foundation pages, ProPublica funder profiles,
            Brave open-web search), <strong>Teaming notices</strong> (SAM.gov), <strong>Unspent federal balances</strong>{" "}
            (USASpending → Pools), and <strong>Settlement boards</strong> (state/county opioid funds). Every lane runs once
            per <strong>scout profile</strong> — Behavioral health (Acme), Technology &amp; IT (Atlas Insights), and Public awareness
            campaigns (Brightline) — so discovery covers every vertical the consortium can sell into.
          </p>
          <p>
            <strong>The rails:</strong> the <em>Run all scans</em> button above, on demand only.{" "}
            <strong>Your job here:</strong> triage each new item — promote the good ones into Opportunities, dismiss the
            noise. Untriaged items auto-dismiss after 30 days.
          </p>
        </PageInfo>
        {/* The in-app scheduled rail (launchd plist + Vercel crons) was retired
            2026-08-13 — it never actually ran (plist never installed, app not on
            Vercel). Saying so here beats a page that implies otherwise. */}
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Scheduled discovery is handled by Alfred&rsquo;s agent crons</strong> (SAM daily/weekly scanners,
          Marketing Scout, Acme+JDS comms scan, Harbor watcher), which write to the Bid Board via <code>fp ingest</code>.
          This page has no scheduled rail of its own — the lanes above run only when you press <em>Run all scans</em>.
        </div>
        <SuggestionInbox paneContextType="scouts" />
        <ScoutProfilesPanel />
        <FoundationsPanel />
        {ingestMsg && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            {ingestMsg}
          </div>
        )}
        {apifyMsg && (
          <pre className="whitespace-pre-wrap rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-900">
            {apifyMsg}
          </pre>
        )}

        <section className="grid grid-cols-3 gap-3">
          <Stat label="Items extracted" value={counts.totalItems} tone="muted" />
          <Stat label="Untriaged" value={counts.totalNew} tone="emerald" />
          <Stat label="Interested" value={counts.totalInterested} tone="amber" />
        </section>

        <section className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="grow">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Search</label>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search digest summaries…"
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Source</label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <FilterChip active={jobFilter === "all"} onClick={() => setJobFilter("all")}>
                All
              </FilterChip>
              {SCOUT_CRON_JOBS.map((j) => (
                <FilterChip
                  key={j.id}
                  active={jobFilter === j.id}
                  onClick={() => setJobFilter(j.id)}
                >
                  {j.label}
                </FilterChip>
              ))}
            </div>
          </div>
        </section>

        {loading ? (
          <div className="space-y-3 pb-12">
            <ScoutsSkeleton />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center">
            {items.length === 0 ? (
              <>
                <p className="text-sm font-medium text-stone-800">No digests ingested yet.</p>
                <p className="mt-2 text-xs leading-5 text-stone-500">
                  Click <em>Pull latest digests</em> above to load the historical Gov Scout cron output.
                </p>
              </>
            ) : (
              <p className="text-sm text-stone-700">No digests match your filter.</p>
            )}
          </div>
        ) : (
          <ul className="space-y-3 pb-12">
            {filtered.map((d) => (
              <DigestRow key={d.id} digest={d} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "muted" | "emerald" | "amber" }) {
  const cls =
    tone === "emerald"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : tone === "amber"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : "border-stone-200 bg-white text-stone-800";
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${cls}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${
        active
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
      }`}
    >
      {children}
    </button>
  );
}

function DigestRow({ digest }: { digest: DigestListItem }) {
  return (
    <li className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/scouts/${digest.id}`}
              className="truncate text-base font-semibold text-emerald-700 hover:underline"
            >
              {digest.sourceLabel}
            </Link>
            <span className="shrink-0 rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-700">
              {fmtDateTime(digest.ranAtMs)}
            </span>
          </div>
          <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-sm leading-6 text-stone-700">
            {digest.summaryPreview}
            {digest.summaryPreview.length >= 280 ? "…" : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-stone-600">
            <span>
              Items: <strong>{digest.itemCount}</strong>
            </span>
            <span>
              New: <strong>{digest.newCount}</strong>
            </span>
            <span>
              Interested: <strong>{digest.interestedCount}</strong>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Link
            href={`/scouts/${digest.id}`}
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            Open →
          </Link>
        </div>
      </div>
    </li>
  );
}
