"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/app/_components/AppHeader";
import {
  SCOUT_ITEM_STATUSES,
  type ScoutItemStatus,
  type ScoutSource,
} from "@/lib/scouts-types";
import type { PoolStatus } from "@/lib/pools-types";

export type PoolPickOption = {
  id: string;
  name: string;
  agency: string | null;
  status: PoolStatus;
};

type ItemRow = {
  id: string;
  source: ScoutSource;
  title: string;
  agency: string | null;
  deadlineText: string | null;
  fundingText: string | null;
  naics: string | null;
  url: string | null;
  rawText: string;
  status: ScoutItemStatus;
  poolId: string | null;
  notes: string | null;
  score: number | null;
  scoreRationale: string | null;
  scoredAt: number | null;
};

// A1: colored fit-score badge. Green ≥70, yellow 40-69, red <40, gray unscored.
export function ScoreBadge({
  score,
  rationale,
}: {
  score: number | null;
  rationale: string | null;
}) {
  if (score == null) {
    return (
      <span
        className="shrink-0 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500"
        title="Unscored — click Score all to grade"
      >
        ?
      </span>
    );
  }
  const cls =
    score >= 70
      ? "border-emerald-600 bg-emerald-100 text-emerald-900"
      : score >= 40
      ? "border-amber-500 bg-amber-100 text-amber-900"
      : "border-red-500 bg-red-100 text-red-900";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
      title={rationale ?? `Fit score ${score}/100`}
    >
      {score}
    </span>
  );
}

type Props = {
  user: { email: string; name: string };
  digest: {
    id: string;
    cronJobId: string;
    sourceLabel: string;
    ranAtMs: number;
    summary: string;
    model: string | null;
    durationMs: number | null;
  };
  initialItems: ItemRow[];
  poolOptions: PoolPickOption[];
};

const STATUS_PILL: Record<ScoutItemStatus, string> = {
  new: "border-stone-300 bg-stone-50 text-stone-700",
  interested: "border-amber-300 bg-amber-50 text-amber-900",
  dismissed: "border-stone-400 bg-stone-200 text-stone-600 line-through",
  promoted: "border-emerald-500 bg-emerald-600 text-white",
};

function fmtDateTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function DigestDetailView({ user, digest, initialItems, poolOptions }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<ItemRow[]>(initialItems);
  const [statusFilter, setStatusFilter] = useState<ScoutItemStatus | "all">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"default" | "score">("default");
  const [scoring, setScoring] = useState(false);
  const [scoreMsg, setScoreMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const base = items.filter((it) =>
      statusFilter === "all" ? true : it.status === statusFilter,
    );
    if (sortBy !== "score") return base;
    return [...base].sort((a, b) => {
      if (a.score == null && b.score == null) return 0;
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return b.score - a.score;
    });
  }, [items, statusFilter, sortBy]);

  async function scoreAll() {
    setScoring(true);
    setScoreMsg(null);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/scouts/score-batch", { method: "POST" });
      const data = (await res.json()) as {
        scored?: number;
        failed?: number;
        attempted?: number;
        items?: { id: string; score: number; rationale: string }[];
        error?: string;
      };
      if (!res.ok) {
        setScoreMsg(`Score batch failed: ${data.error ?? res.statusText}`);
        return;
      }
      if (data.items?.length) {
        const lookup = new Map(data.items.map((x) => [x.id, x] as const));
        setItems((prev) =>
          prev.map((it) => {
            const hit = lookup.get(it.id);
            if (!hit) return it;
            return {
              ...it,
              score: hit.score,
              scoreRationale: hit.rationale,
              scoredAt: Date.now(),
            };
          }),
        );
        setSortBy("score");
      }
      setScoreMsg(
        `Scored ${data.scored ?? 0} of ${data.attempted ?? 0}${data.failed ? ` (${data.failed} failed)` : ""}.`,
      );
    } catch (err) {
      setScoreMsg(`Score batch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScoring(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<ScoutItemStatus | "all", number> = {
      all: items.length,
      new: 0,
      interested: 0,
      dismissed: 0,
      promoted: 0,
    };
    for (const it of items) c[it.status] += 1;
    return c;
  }, [items]);

  async function patchItem(itemId: string, patch: Partial<Pick<ItemRow, "status" | "notes" | "poolId">>) {
    const prev = items;
    setItems((s) => s.map((it) => (it.id === itemId ? { ...it, ...patch } : it)));
    setBusyId(itemId);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/scouts/items/${itemId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        setItems(prev);
        setErrorMsg(`Update failed: ${res.statusText}`);
      }
    } catch (err) {
      setItems(prev);
      setErrorMsg(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  async function promote(itemId: string, poolId?: string) {
    setBusyId(itemId);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/scouts/items/${itemId}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(poolId ? { poolId } : {}),
      });
      const data = (await res.json()) as { item?: ItemRow; poolId?: string; error?: string };
      if (!res.ok || !data.item) {
        setErrorMsg(`Promote failed: ${data.error ?? res.statusText}`);
        return;
      }
      const newPoolId = data.poolId ?? data.item.poolId;
      setItems((s) =>
        s.map((it) => (it.id === itemId ? { ...it, status: "promoted", poolId: newPoolId ?? null } : it)),
      );
      router.refresh();
    } catch (err) {
      setErrorMsg(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Scouts · digest"
        title={digest.sourceLabel}
        subtitle={`${fmtDateTime(digest.ranAtMs)} · ${items.length} items extracted`}
        userLabel={user.name}
        activeNav="scouts"
        leadingActions={
          <Link
            href="/scouts"
            className="rounded-md border border-stone-400 bg-white/80 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            ← All digests
          </Link>
        }
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <FilterChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
              All <span className="opacity-60">({counts.all})</span>
            </FilterChip>
            {SCOUT_ITEM_STATUSES.map((s) => (
              <FilterChip
                key={s}
                active={statusFilter === s}
                onClick={() => setStatusFilter(s)}
              >
                {s} <span className="opacity-60">({counts[s]})</span>
              </FilterChip>
            ))}
            <span className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSortBy((v) => (v === "score" ? "default" : "score"))}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
                  sortBy === "score"
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
                }`}
              >
                Sort by fit
              </button>
              <button
                type="button"
                onClick={scoreAll}
                disabled={scoring}
                className="rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                {scoring ? "Scoring…" : "Score all"}
              </button>
            </span>
          </div>
          {scoreMsg && (
            <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              {scoreMsg}
            </div>
          )}
          {errorMsg && (
            <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {errorMsg}
            </div>
          )}
          {filtered.length === 0 ? (
            <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-6 text-center text-sm text-stone-600">
              No items match this filter.
            </p>
          ) : (
            <ul className="space-y-3">
              {filtered.map((it) => (
                <ItemCard
                  key={it.id}
                  item={it}
                  poolOptions={poolOptions}
                  busy={busyId === it.id}
                  onPatch={(patch) => patchItem(it.id, patch)}
                  onPromote={(poolId) => promote(it.id, poolId)}
                />
              ))}
            </ul>
          )}
        </section>

        <aside className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-stone-800">Raw digest</h2>
          <p className="mb-3 text-[11px] text-stone-500">
            Source markdown as it landed in Telegram.
            {digest.model ? ` · model: ${digest.model}` : ""}
            {digest.durationMs ? ` · ${(digest.durationMs / 1000).toFixed(1)}s` : ""}
          </p>
          <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded-md border border-stone-200 bg-stone-50 p-3 text-[11px] leading-5 text-stone-800">
            {digest.summary}
          </pre>
        </aside>
      </div>
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

function ItemCard({
  item,
  poolOptions,
  busy,
  onPatch,
  onPromote,
}: {
  item: ItemRow;
  poolOptions: PoolPickOption[];
  busy: boolean;
  onPatch: (patch: Partial<Pick<ItemRow, "status" | "notes" | "poolId">>) => void;
  onPromote: (poolId?: string) => void;
}) {
  const [showLink, setShowLink] = useState(false);
  const [pickPoolId, setPickPoolId] = useState<string>("");
  return (
    <li className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ScoreBadge score={item.score} rationale={item.scoreRationale} />
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_PILL[item.status]}`}
            >
              {item.status}
            </span>
            <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-700">
              {item.source}
            </span>
            <h3 className="truncate text-sm font-semibold text-stone-900">{item.title}</h3>
          </div>
          {item.scoreRationale && (
            <p className="mt-1 text-[11px] italic text-stone-500">
              Fit: {item.scoreRationale}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-stone-600">
            {item.agency && (
              <span>
                Agency: <strong>{item.agency}</strong>
              </span>
            )}
            {item.deadlineText && (
              <span>
                Deadline: <strong>{item.deadlineText}</strong>
              </span>
            )}
            {item.fundingText && (
              <span>
                Funding: <strong>{item.fundingText}</strong>
              </span>
            )}
            {item.naics && (
              <span>
                NAICS: <strong>{item.naics}</strong>
              </span>
            )}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 underline"
              >
                Source link ↗
              </a>
            )}
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] text-stone-500 hover:text-stone-700">
              Show raw markdown
            </summary>
            <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-stone-200 bg-stone-50 p-2 text-[11px] leading-5 text-stone-800">
              {item.rawText}
            </pre>
          </details>
          {item.poolId && (
            <p className="mt-2 text-[11px] text-emerald-800">
              Linked pool:{" "}
              <Link href={`/pools/${item.poolId}`} className="underline">
                view →
              </Link>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <select
            value={item.status}
            disabled={busy}
            onChange={(e) => onPatch({ status: e.target.value as ScoutItemStatus })}
            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 shadow-sm"
          >
            {SCOUT_ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {item.status !== "promoted" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowLink((v) => !v)}
              className="rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              {showLink ? "Cancel" : "Promote → Pool"}
            </button>
          )}
        </div>
      </div>
      {showLink && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50/50 p-3">
          <p className="text-[11px] font-medium text-emerald-900">
            Create a new pool from this item, or link to an existing one.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={pickPoolId}
              onChange={(e) => setPickPoolId(e.target.value)}
              className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 shadow-sm"
            >
              <option value="">— new pool —</option>
              {poolOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.agency ? ` (${p.agency})` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onPromote(pickPoolId || undefined);
                setShowLink(false);
              }}
              className="rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {pickPoolId ? "Link to pool" : "Create pool"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
