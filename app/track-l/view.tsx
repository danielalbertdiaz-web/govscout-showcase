"use client";

// Track L §6 — Earmarked Awareness Radar list UI. (a) filterable, sortable
// table; (b) row click → detail drawer with contacts / funding events /
// signals / reason codes; (c) empty/loading/error states per app patterns.
// Explicitly NOT here in P1: map view, kanban, metrics strip, draft queue.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";
import {
  TIERS,
  FUNDING_PROGRAMS,
  type AgencyListRow,
  type AgencyDetail,
  type Tier,
  type FundingProgram,
} from "@/lib/track-l-types";

type Props = {
  user: { email: string; name: string };
  initialAgencies: AgencyListRow[];
  initialTotal: number;
  stats: { agencies: number; totalContacts: number; fundingEvents: number; dreamAgencies: number };
};

const STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
];

const PROGRAM_LABELS: Record<FundingProgram, string> = {
  HUD_LHC: "HUD Lead Hazard Control",
  HUD_HH: "HUD Healthy Homes",
  EPA_WIIN: "EPA WIIN",
  LSLR_STATE: "State LSLR",
  OPIOID: "Opioid settlement",
  OTHER: "Other",
};

const TYPE_LABELS: Record<string, string> = {
  STATE_HEALTH: "State health",
  LOCAL_HEALTH: "Local health",
  WATER_SYSTEM: "Water system",
  HOUSING: "Housing",
  OTHER: "Gov (other)",
};

const PRIORITY_LABELS: Record<string, string> = {
  P1_CLPPP: "P1 · CLPPP",
  P2_HEALTH_OFFICER: "P2 · Health officer",
  P3_PIO: "P3 · PIO",
  P4_GENERIC: "P4 · Generic",
};

const fmtUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function tierBadge(tier: Tier): string {
  switch (tier) {
    case "DREAM":
      return "bg-emerald-50 border-emerald-200 text-emerald-700";
    case "STANDARD":
      return "bg-amber-50 border-amber-200 text-amber-700";
    default:
      return "bg-stone-50 border-stone-200 text-stone-500";
  }
}

type Sort = "score" | "name" | "state" | "contacts";

export default function TrackLView({ user, initialAgencies, initialTotal, stats }: Props) {
  const [agencies, setAgencies] = useState<AgencyListRow[]>(initialAgencies);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [state, setState] = useState("");
  const [tier, setTier] = useState("");
  const [program, setProgram] = useState("");
  const [scoreMin, setScoreMin] = useState("");
  const [scoreMax, setScoreMax] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("score");
  const [offset, setOffset] = useState(0);
  const LIMIT = 100;

  const [detail, setDetail] = useState<AgencyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<string | null>(null);

  const firstRender = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (state) params.set("state", state);
      if (tier) params.set("tier", tier);
      if (program) params.set("program", program);
      if (scoreMin) params.set("scoreMin", scoreMin);
      if (scoreMax) params.set("scoreMax", scoreMax);
      if (q) params.set("q", q);
      params.set("sort", sort);
      params.set("limit", String(LIMIT));
      params.set("offset", String(offset));
      const res = await fetch(`/api/track-l/agencies?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { agencies: AgencyListRow[]; total: number };
      setAgencies(body.agencies);
      setTotal(body.total);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [state, tier, program, scoreMin, scoreMax, q, sort, offset]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return; // initial data came from the server render
    }
    const t = setTimeout(load, 250); // debounce free-text / score typing
    return () => clearTimeout(t);
  }, [load]);

  const openDetail = async (id: string) => {
    setDetailLoading(id);
    try {
      const res = await fetch(`/api/track-l/agencies/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { agency: AgencyDetail };
      setDetail(body.agency);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDetailLoading(null);
    }
  };

  const resetOffsetAnd = <T,>(setter: (v: T) => void) => (v: T) => {
    setOffset(0);
    setter(v);
  };

  const selectCls =
    "rounded border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-700 focus:border-emerald-500 focus:outline-none";

  return (
    <div className="mx-auto max-w-7xl px-6 pt-3">
      <AppHeader
        tagline="Earmarked Awareness Radar"
        title="Track L"
        subtitle={`${stats.agencies.toLocaleString()} agencies · ${stats.fundingEvents.toLocaleString()} funding events · ${stats.totalContacts.toLocaleString()} contacts · ${stats.dreamAgencies} Dream`}
        userLabel={user.name}
      />

      <div className="mt-4 flex flex-col gap-4 pb-16">
        <PageInfo id="track-l" title="What is Track L?">
          <p>
            US health, housing, and government agencies holding earmarked lead-hazard and awareness
            funds — scored on award recency, spend deadlines, pre-1978 housing stock, blood-lead
            surveillance, and LSLR participation. Reason codes on every scored agency show exactly
            why it ranks. Data: NACCHO directory, state CLPPP programs, USAspending (HUD LHC/HH),
            Census ACS B25034.
          </p>
        </PageInfo>

        {/* Filters (§6a) */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => resetOffsetAnd(setQ)(e.target.value)}
            placeholder="Search agency / county…"
            className={`${selectCls} w-52`}
          />
          <select value={state} onChange={(e) => resetOffsetAnd(setState)(e.target.value)} className={selectCls}>
            <option value="">All states</option>
            {STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={tier} onChange={(e) => resetOffsetAnd(setTier)(e.target.value)} className={selectCls}>
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select value={program} onChange={(e) => resetOffsetAnd(setProgram)(e.target.value)} className={selectCls}>
            <option value="">All programs</option>
            {FUNDING_PROGRAMS.map((p) => (
              <option key={p} value={p}>{PROGRAM_LABELS[p]}</option>
            ))}
          </select>
          <div className="flex items-center gap-1 text-xs text-stone-500">
            score
            <input
              value={scoreMin}
              onChange={(e) => resetOffsetAnd(setScoreMin)(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="min"
              className={`${selectCls} w-14`}
            />
            –
            <input
              value={scoreMax}
              onChange={(e) => resetOffsetAnd(setScoreMax)(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="max"
              className={`${selectCls} w-14`}
            />
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={selectCls}>
            <option value="score">Sort: score</option>
            <option value="name">Sort: name</option>
            <option value="state">Sort: state</option>
            <option value="contacts">Sort: contacts</option>
          </select>
          <span className="ml-auto text-xs tabular-nums text-stone-400">
            {loading ? "loading…" : `${total.toLocaleString()} agencies`}
          </span>
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Failed to load agencies: {error}{" "}
            <button onClick={load} className="underline">retry</button>
          </div>
        )}

        {/* Table (§6a) */}
        {agencies.length === 0 && !loading ? (
          <div className="rounded-lg border border-dashed border-stone-200 px-4 py-10 text-center text-sm text-stone-400">
            No agencies match these filters. The harvest may still be running — check back shortly.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-stone-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Agency</th>
                  <th className="px-2 py-2 font-medium">State</th>
                  <th className="px-2 py-2 font-medium">County</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 font-medium">Tier</th>
                  <th className="px-2 py-2 text-right font-medium">Score</th>
                  <th className="px-2 py-2 font-medium">Top program</th>
                  <th className="px-2 py-2 text-right font-medium">Contacts</th>
                </tr>
              </thead>
              <tbody>
                {agencies.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => openDetail(a.id)}
                    className={`cursor-pointer border-b border-stone-100 last:border-0 hover:bg-emerald-50/40 ${
                      detailLoading === a.id ? "opacity-60" : ""
                    }`}
                  >
                    <td className="max-w-72 truncate px-3 py-2 font-medium text-stone-900" title={a.name}>
                      {a.name}
                    </td>
                    <td className="px-2 py-2 text-stone-600">{a.state}</td>
                    <td className="max-w-32 truncate px-2 py-2 text-stone-500">{a.county ?? "—"}</td>
                    <td className="px-2 py-2 text-xs text-stone-500">{TYPE_LABELS[a.type] ?? a.type}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${tierBadge(a.tier)}`}>
                        {a.tier}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-stone-800">{a.score}</td>
                    <td className="px-2 py-2 text-xs text-stone-500">
                      {a.topProgram ? PROGRAM_LABELS[a.topProgram] : "—"}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-stone-600">{a.contactCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > LIMIT && (
          <div className="flex items-center justify-between text-xs text-stone-500">
            <button
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              className="rounded border border-stone-200 px-2 py-1 disabled:opacity-40"
            >
              ← Prev
            </button>
            <span className="tabular-nums">
              {offset + 1}–{Math.min(offset + LIMIT, total)} of {total.toLocaleString()}
            </span>
            <button
              disabled={offset + LIMIT >= total || loading}
              onClick={() => setOffset(offset + LIMIT)}
              className="rounded border border-stone-200 px-2 py-1 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {/* Detail drawer (§6b) */}
      {detail && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-stone-900/30" onClick={() => setDetail(null)} />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col overflow-y-auto border-l border-stone-200 bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-stone-900">{detail.name}</div>
                <div className="mt-0.5 text-xs text-stone-500">
                  {detail.state}
                  {detail.county ? ` · ${detail.county} County` : ""} · {TYPE_LABELS[detail.type] ?? detail.type}
                  {detail.website ? (
                    <>
                      {" · "}
                      <a href={detail.website} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">
                        website ↗
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                onClick={() => setDetail(null)}
                className="rounded border border-stone-200 px-2 py-1 text-xs text-stone-500 hover:bg-stone-50"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <span className={`rounded border px-2 py-1 text-xs font-semibold ${tierBadge(detail.tier)}`}>
                {detail.tier}
              </span>
              <span className="text-2xl font-semibold tabular-nums text-stone-900">{detail.score}</span>
              <span className="text-xs text-stone-400">score</span>
              {detail.housingPre1978Pct != null && (
                <span className="ml-auto text-xs text-stone-500">
                  pre-1978 housing {Math.round(detail.housingPre1978Pct)}%
                </span>
              )}
            </div>

            {/* Reason codes — rendered prominently (§6b) */}
            <div className="mt-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">Why this score</div>
              {detail.reasonCodes.length === 0 ? (
                <p className="mt-1 text-sm text-stone-400">No scoring inputs yet.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {detail.reasonCodes.map((r, i) => (
                    <li
                      key={i}
                      className="rounded border border-emerald-100 bg-emerald-50/60 px-2 py-1.5 text-[13px] text-emerald-900"
                    >
                      {r}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {(detail.procurementThreshold != null || detail.quoteRequirement) && (
              <div className="mt-4 text-xs text-stone-600">
                {detail.procurementThreshold != null && (
                  <div>Procurement threshold: {fmtUsd.format(detail.procurementThreshold)}</div>
                )}
                {detail.quoteRequirement && <div>Quote requirement: {detail.quoteRequirement}</div>}
              </div>
            )}

            <div className="mt-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Funding events ({detail.fundingEvents.length})
              </div>
              {detail.fundingEvents.length === 0 ? (
                <p className="mt-1 text-sm text-stone-400">None recorded.</p>
              ) : (
                <div className="mt-1 flex flex-col gap-1.5">
                  {detail.fundingEvents.map((fe) => (
                    <div key={fe.id} className="rounded border border-stone-200 p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-stone-800">{PROGRAM_LABELS[fe.program]}</span>
                        {fe.amount != null && (
                          <span className="tabular-nums font-semibold text-stone-800">{fmtUsd.format(fe.amount)}</span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center justify-between text-stone-500">
                        <span>
                          {fe.awardDate ? `awarded ${fe.awardDate.slice(0, 10)}` : "award date unknown"}
                          {fe.spendDeadline ? ` · spend by ${fe.spendDeadline.slice(0, 10)}` : ""}
                        </span>
                        <a href={fe.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">
                          source ↗
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Contacts ({detail.contacts.length})
              </div>
              {detail.contacts.length === 0 ? (
                <p className="mt-1 text-sm text-stone-400">No contacts harvested yet.</p>
              ) : (
                <div className="mt-1 flex flex-col gap-1.5">
                  {detail.contacts.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2 rounded border border-stone-200 p-2 text-xs">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-stone-800">
                          {c.name ?? c.email}
                          {c.title ? <span className="font-normal text-stone-500"> · {c.title}</span> : null}
                        </div>
                        <div className="truncate text-stone-500">{c.email}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {c.isGeneric && (
                          <span className="rounded border border-stone-200 bg-stone-50 px-1 py-0.5 text-[10px] text-stone-400">
                            generic
                          </span>
                        )}
                        <span className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-600">
                          {PRIORITY_LABELS[c.priority] ?? c.priority}
                        </span>
                        {c.sourceUrl ? (
                          <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline" title={c.source}>
                            {c.source.toLowerCase()} ↗
                          </a>
                        ) : (
                          <span className="text-stone-400">{c.source.toLowerCase()}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-5 pb-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Signals ({detail.signals.length})
              </div>
              {detail.signals.length === 0 ? (
                <p className="mt-1 text-sm text-stone-400">None recorded.</p>
              ) : (
                <div className="mt-1 flex flex-col gap-1.5">
                  {detail.signals.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 rounded border border-stone-200 p-2 text-xs">
                      <span className="text-stone-700">
                        {s.type.replace(/_/g, " ").toLowerCase()}
                        {s.note ? <span className="text-stone-500"> — {s.note}</span> : null}
                      </span>
                      <span className="shrink-0 tabular-nums text-stone-500">+{s.weight}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
