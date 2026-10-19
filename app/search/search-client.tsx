"use client";

import { PartnerRecs } from "./partner-recs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader, APP_HEADER_NAV_BASE, APP_HEADER_NAV_MUTED } from "@/app/_components/AppHeader";

type SearchResult = {
  source: "govscout" | "grants_gov" | "sam_gov";
  sourceId: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  fundingFloor: string | null;
  fundingCeiling: string | null;
  eligibility: string | null;
  url: string | null;
  nofoUrl: string | null;
  summary: string | null;
  naics: string | null;
  raw: Record<string, unknown> | null;
  saved?: boolean;
};

type Digest = {
  jobId: string;
  runAtMs: number;
  summary: string;
};

type SearchResponse = {
  results: SearchResult[];
  digests: Digest[];
  errors: { source: string; message: string }[];
  counts: { total: number; bySource: Record<string, number> };
};

type Props = {
  user: { email: string; name: string };
  samConfigured: boolean;
};

const INPUT_BASE =
  "rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900 shadow-sm transition placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500";

const PRIMARY_BTN =
  "rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-600/40 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500";

const LABEL = "text-xs font-semibold uppercase tracking-wider text-stone-700";

const SOURCE_LABELS: Record<SearchResult["source"], { label: string; tone: string }> = {
  govscout: { label: "Gov Scout", tone: "bg-amber-100 text-amber-900 border-amber-300" },
  grants_gov: { label: "grants.gov", tone: "bg-blue-100 text-blue-900 border-blue-300" },
  sam_gov: { label: "SAM.gov", tone: "bg-violet-100 text-violet-900 border-violet-300" },
};

// All verticals: acme consulting/behavioral-health + Atlas Insights tech (541519,
// 518210) + Brightline awareness/marketing (541613, 541810, 541820, 541910).
const PRESET_NAICS =
  "541611, 541618, 541614, 541990, 541512, 541511, 541513, 541519, 518210, 541613, 541810, 541820, 541910, 541715, 541720, 611310, 611430, 611699, 621498, 621420, 621491, 621999, 623220, 624190, 624229";

export default function SearchClient({ user, samConfigured }: Props) {
  const router = useRouter();

  const [q, setQ] = useState("");
  const [agency, setAgency] = useState("");
  const [naics, setNaics] = useState("");
  const [status, setStatus] = useState<"open" | "closed" | "all">("open");
  const [source, setSource] = useState<"all" | "govscout" | "grants_gov" | "sam_gov">("all");
  const [deadlineFrom, setDeadlineFrom] = useState("");
  const [deadlineTo, setDeadlineTo] = useState("");
  const [fundingFloorMin, setFundingFloorMin] = useState("");
  const [fundingCeilingMax, setFundingCeilingMax] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [digests, setDigests] = useState<Digest[]>([]);
  const [sourceErrors, setSourceErrors] = useState<{ source: string; message: string }[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [correctedQuery, setCorrectedQuery] = useState<string | null>(null);
  const [scoutStatus, setScoutStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // One in-flight search at a time: a new run aborts the previous request so
  // a slow stale response can never clobber newer results (the bug that made
  // keyword searches "return nothing").
  const searchAbortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(async () => {
    searchAbortRef.current?.abort();
    const ctrl = new AbortController();
    searchAbortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setSourceErrors([]);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (agency) params.set("agency", agency);
      if (naics) params.set("naics", naics);
      if (status) params.set("status", status);
      if (source) params.set("source", source);
      if (deadlineFrom) params.set("deadlineFrom", deadlineFrom);
      if (deadlineTo) params.set("deadlineTo", deadlineTo);
      if (fundingFloorMin) params.set("fundingFloorMin", fundingFloorMin);
      if (fundingCeilingMax) params.set("fundingCeilingMax", fundingCeilingMax);

      const res = await fetch(`/api/search?${params.toString()}`, { cache: "no-store", signal: ctrl.signal });
      const data = (await res.json().catch(() => ({}))) as SearchResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Search failed (${res.status})`);
        return;
      }
      setResults(data.results ?? []);
      setDigests(data.digests ?? []);
      setSourceErrors(data.errors ?? []);
      setCorrectedQuery((data as { correctedQuery?: string | null }).correctedQuery ?? null);
      const initialSaved = new Set<string>();
      for (const r of data.results ?? []) {
        if (r.saved) initialSaved.add(`${r.source}:${r.sourceId}`);
      }
      setSavedKeys(initialSaved);
    } catch (err) {
      // An aborted request means a newer search superseded this one — silence.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (searchAbortRef.current === ctrl) setLoading(false);
    }
  }, [agency, deadlineFrom, deadlineTo, fundingCeilingMax, fundingFloorMin, naics, q, source, status]);

  // S1: stable inputs for the partner-recommendation rail (memoized so the
  // rail's fetch effect fires once per result set, not per render).
  const recTitles = useMemo(() => results.map((r) => r.title).slice(0, 10), [results]);
  const topGrant = useMemo(
    () =>
      results[0]
        ? { title: results[0].title, agency: results[0].agency, deadline: results[0].deadline, url: results[0].url }
        : null,
    [results],
  );

  // "Save as scout" (P14): the current search becomes a recurring vertical.
  // The effective query (after typo correction) seeds the keywords; commas
  // split multi-topic queries into separate keywords; the NAICS filter rides
  // along. The new scout joins every scan lane on the next rail run.
  const saveAsScout = useCallback(async () => {
    const effectiveQ = (correctedQuery ?? q).trim();
    if (!effectiveQ) return;
    setScoutStatus("saving");
    try {
      const res = await fetch("/api/scouts/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: effectiveQ,
          keywords: effectiveQ.split(",").map((s) => s.trim()).filter(Boolean),
          naics: naics.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setScoutStatus(res.ok ? "saved" : "error");
      if (res.ok) setTimeout(() => setScoutStatus("idle"), 4000);
    } catch {
      setScoutStatus("error");
    }
  }, [correctedQuery, q, naics]);

  // Auto-run ONE initial empty search on mount so the user lands on something.
  // Deliberately not keyed on runSearch: depending on it re-fired a full
  // multi-API search on every keystroke (runSearch is recreated when any form
  // field changes), racing stale responses over fresh ones.
  const didInitialSearch = useRef(false);
  useEffect(() => {
    if (didInitialSearch.current) return;
    didInitialSearch.current = true;
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveOpp = useCallback(
    async (r: SearchResult) => {
      const key = `${r.source}:${r.sourceId}`;
      setSavingId(key);
      try {
        const res = await fetch("/api/opportunities", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: r.source,
            sourceId: r.sourceId,
            title: r.title,
            agency: r.agency,
            deadline: r.deadline,
            fundingFloor: r.fundingFloor,
            fundingCeiling: r.fundingCeiling,
            eligibility: r.eligibility,
            url: r.url,
            nofoUrl: r.nofoUrl,
            summary: r.summary,
            naics: r.naics,
            raw: r.raw,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(`Save failed: ${data.error ?? res.statusText}`);
          return;
        }
        setSavedKeys((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      } finally {
        setSavingId(null);
      }
    },
    [],
  );

  const sendToBuilder = useCallback(
    (r: SearchResult) => {
      const params = new URLSearchParams();
      params.set("source", r.source);
      params.set("sourceId", r.sourceId);
      params.set("title", r.title);
      if (r.agency) params.set("agency", r.agency);
      if (r.deadline) params.set("deadline", r.deadline);
      if (r.fundingFloor) params.set("fundingFloor", r.fundingFloor);
      if (r.fundingCeiling) params.set("fundingCeiling", r.fundingCeiling);
      if (r.eligibility) params.set("eligibility", r.eligibility);
      if (r.url) params.set("url", r.url);
      if (r.nofoUrl) params.set("nofoUrl", r.nofoUrl);
      if (r.summary) params.set("summary", r.summary);
      if (r.naics) params.set("naics", r.naics);
      router.push(`/workbench?${params.toString()}`);
    },
    [router],
  );

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of results) out[r.source] = (out[r.source] ?? 0) + 1;
    return out;
  }, [results]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-6 py-6">
      <AppHeader
        tagline="Grant search"
        title="Find opportunities, save the good ones, send them to the builder."
        subtitle={
          <>
            Sources: Gov Scout daily digest · grants.gov live API · SAM.gov{" "}
            {samConfigured ? (
              <span className="text-emerald-200">(API key configured)</span>
            ) : (
              <span className="text-amber-200">(API key not set)</span>
            )}
            {savedKeys.size > 0 ? (
              <span className="text-white/60"> · {savedKeys.size} saved</span>
            ) : null}
          </>
        }
        userLabel={user.name}
        activeNav="search"
        trailingActions={
          <button
            onClick={logout}
            className={`${APP_HEADER_NAV_BASE} ${APP_HEADER_NAV_MUTED}`}
          >
            Sign out
          </button>
        }
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* Filters */}
        <aside className="space-y-4 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div>
            <label className={LABEL}>Keyword</label>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. RCORP rural opioid, behavioral health, SBIR"
              className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runSearch();
              }}
            />
          </div>
          <div>
            <label className={LABEL}>Agency (free text)</label>
            <input
              type="text"
              value={agency}
              onChange={(e) => setAgency(e.target.value)}
              placeholder="HRSA, SAMHSA, HUD, DOL…"
              className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
            />
          </div>
          <div>
            <label className={LABEL}>NAICS codes</label>
            <input
              type="text"
              value={naics}
              onChange={(e) => setNaics(e.target.value)}
              placeholder="541611, 621498…"
              className={`mt-1 block w-full ${INPUT_BASE} text-sm font-mono`}
            />
            <button
              type="button"
              onClick={() => setNaics(PRESET_NAICS)}
              className="mt-1 text-[11px] text-emerald-700 hover:underline"
            >
              Use Acme Consulting NAICS preset
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL}>Funding floor ≥</label>
              <input
                type="number"
                value={fundingFloorMin}
                onChange={(e) => setFundingFloorMin(e.target.value)}
                placeholder="100000"
                className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
              />
            </div>
            <div>
              <label className={LABEL}>Ceiling ≤</label>
              <input
                type="number"
                value={fundingCeilingMax}
                onChange={(e) => setFundingCeilingMax(e.target.value)}
                placeholder="5000000"
                className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL}>Deadline from</label>
              <input
                type="date"
                value={deadlineFrom}
                onChange={(e) => setDeadlineFrom(e.target.value)}
                className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
              />
            </div>
            <div>
              <label className={LABEL}>Deadline to</label>
              <input
                type="date"
                value={deadlineTo}
                onChange={(e) => setDeadlineTo(e.target.value)}
                className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
              />
            </div>
          </div>
          <div>
            <label className={LABEL}>Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
            >
              <option value="open">Open / forecasted</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          </div>
          <div>
            <label className={LABEL}>Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              className={`mt-1 block w-full ${INPUT_BASE} text-sm`}
            >
              <option value="all">All sources</option>
              <option value="govscout">Gov Scout digest only</option>
              <option value="grants_gov">grants.gov only</option>
              <option value="sam_gov">SAM.gov only</option>
            </select>
          </div>
          <button
            onClick={() => void runSearch()}
            disabled={loading}
            className={`w-full ${PRIMARY_BTN}`}
          >
            {loading ? "Searching…" : "Search"}
          </button>
          {q.trim() && (
            <button
              onClick={() => void saveAsScout()}
              disabled={scoutStatus === "saving" || scoutStatus === "saved"}
              className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-60"
              title="Turn this search into a recurring scout: its keywords and NAICS codes join every automated scan lane."
            >
              {scoutStatus === "saving"
                ? "Creating scout…"
                : scoutStatus === "saved"
                  ? "✓ Scout created — see /scouts"
                  : scoutStatus === "error"
                    ? "Couldn't create — retry?"
                    : "⊕ Save this search as a scout"}
            </button>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs leading-5 text-red-800">
              {error}
            </div>
          )}
          {sourceErrors.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              <strong className="font-semibold">Source warnings:</strong>
              <ul className="mt-1 list-inside list-disc space-y-1">
                {sourceErrors.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.source}</span>: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        {/* Results */}
        <div className="space-y-4">
          {correctedQuery && (
            <div className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
              No matches for &ldquo;{q}&rdquo; — showing results for{" "}
              <button
                className="font-semibold underline underline-offset-2"
                onClick={() => setQ(correctedQuery)}
              >
                {correctedQuery}
              </button>{" "}
              instead.
            </div>
          )}
          <PartnerRecs query={correctedQuery ?? q} titles={recTitles} topGrant={topGrant} />
          {digests.length > 0 && (source === "all" || source === "govscout") && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-amber-900">
                    Curated by Gov Scout
                  </div>
                  <h2 className="mt-0.5 text-base font-semibold text-stone-900">Latest daily digest</h2>
                </div>
                <span className="text-[11px] text-stone-600">
                  {digests[0] ? new Date(digests[0].runAtMs).toLocaleString() : ""}
                </span>
              </div>
              <details className="mt-3" open>
                <summary className="cursor-pointer text-xs font-medium text-amber-800 hover:underline">
                  Show digest text ({digests.length} run{digests.length === 1 ? "" : "s"})
                </summary>
                <div className="gs-scroll mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-amber-200 bg-white p-3 font-mono text-[11px] leading-5 text-stone-800">
                  {digests.map((d, i) => (
                    <div key={i} className={i > 0 ? "mt-4 border-t border-amber-200 pt-3" : ""}>
                      <div className="mb-1 text-[10px] font-semibold uppercase text-amber-700">
                        {new Date(d.runAtMs).toLocaleString()} — job {d.jobId.slice(0, 8)}
                      </div>
                      {d.summary}
                    </div>
                  ))}
                </div>
              </details>
              <p className="mt-2 text-[11px] leading-5 text-stone-600">
                Gov Scout&rsquo;s daily cron is a free-form markdown digest delivered via Telegram — no structured row schema. Skim
                the digest, then click any <strong>grants.gov</strong>/<strong>SAM.gov</strong> result below to save and send to the builder.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
            <span className="flex flex-wrap items-center gap-x-2">
              <span className="font-semibold text-stone-800">{results.length} result{results.length === 1 ? "" : "s"}</span>
              {Object.entries(counts).map(([s, n]) => (
                <span
                  key={s}
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${SOURCE_LABELS[s as SearchResult["source"]]?.tone ?? "bg-stone-100 text-stone-700 border-stone-300"}`}
                >
                  {SOURCE_LABELS[s as SearchResult["source"]]?.label ?? s} · {n}
                </span>
              ))}
            </span>
            <span className="text-[11px] text-stone-500">{savedKeys.size} saved this session</span>
          </div>

          {loading && results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
              Searching grants.gov live…
            </div>
          ) : results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center">
              <p className="text-sm font-medium text-stone-800">No results.</p>
              <p className="mt-2 text-xs leading-5 text-stone-500">
                Try a broader keyword (e.g., &ldquo;opioid&rdquo;), drop the NAICS filter, or switch status to &ldquo;All&rdquo;.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {results.map((r) => {
                const key = `${r.source}:${r.sourceId}`;
                const isSaved = savedKeys.has(key);
                const tone = SOURCE_LABELS[r.source]?.tone ?? "bg-stone-100 text-stone-700 border-stone-300";
                return (
                  <li key={key} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}>
                            {SOURCE_LABELS[r.source]?.label ?? r.source}
                          </span>
                          {r.deadline && (
                            <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-medium text-stone-700">
                              ⏱ {r.deadline}
                            </span>
                          )}
                          {(r.fundingFloor || r.fundingCeiling) && (
                            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                              💰 {[r.fundingFloor, r.fundingCeiling].filter(Boolean).join(" – ")}
                            </span>
                          )}
                          {r.naics && (
                            <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-mono text-stone-700">
                              NAICS {r.naics}
                            </span>
                          )}
                        </div>
                        {r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block truncate text-base font-semibold text-emerald-700 hover:underline"
                          >
                            {r.title}
                          </a>
                        ) : (
                          <h3 className="mt-1 truncate text-base font-semibold text-stone-900">{r.title}</h3>
                        )}
                        {r.agency && <p className="mt-0.5 text-sm text-stone-700">{r.agency}</p>}
                        {r.eligibility && (
                          <p className="mt-1 line-clamp-2 text-xs text-stone-600">
                            <span className="font-semibold uppercase tracking-wider text-stone-500">Eligibility · </span>
                            {r.eligibility}
                          </p>
                        )}
                        {r.summary && (
                          <p className="mt-1 line-clamp-2 text-xs text-stone-600">{r.summary}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-stretch gap-2">
                        <button
                          onClick={() => void saveOpp(r)}
                          disabled={isSaved || savingId === key}
                          className="rounded-md border border-amber-500 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 disabled:cursor-default disabled:bg-amber-200 disabled:text-amber-700"
                        >
                          {isSaved ? "★ Saved" : savingId === key ? "Saving…" : "★ Save"}
                        </button>
                        <button
                          onClick={() => sendToBuilder(r)}
                          className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
                        >
                          → Send to Builder
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
