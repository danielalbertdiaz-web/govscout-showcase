"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";
import { SuggestionInbox } from "@/app/_components/SuggestionInbox";
import { POOL_STATUSES, type PoolStatus } from "@/lib/pools-types";

export type PoolListItem = {
  id: string;
  rank: number | null;
  name: string;
  agency: string | null;
  jurisdiction: string | null;
  status: PoolStatus;
  playType: string | null;
  allocatedAmount: string | null;
  unspentAmount: string | null;
  deadlineDate: string | null;
  deadlineLabel: string | null;
  fitSummary: string | null;
  nextAction: string | null;
  tags: string[];
  updatedAt: number;
};

type Props = {
  user: { email: string; name: string };
  initial: PoolListItem[];
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

const STATUS_PILL: Record<PoolStatus, string> = {
  discovered: "border-stone-300 bg-stone-50 text-stone-700",
  researched: "border-sky-300 bg-sky-50 text-sky-800",
  engaged: "border-amber-300 bg-amber-50 text-amber-900",
  "in-proposal": "border-emerald-300 bg-emerald-50 text-emerald-800",
  won: "border-emerald-500 bg-emerald-600 text-white",
  lost: "border-stone-400 bg-stone-200 text-stone-700",
};

function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Loading skeleton for pools
function PoolsSkeleton() {
  return (
    <>
      {[...Array(6)].map((_, i) => (
        <div key={i} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="animate-pulse">
            <div className="flex items-start justify-between">
              <div className="space-y-2 flex-1">
                <div className="h-4 bg-stone-200 rounded w-3/4"></div>
                <div className="h-3 bg-stone-100 rounded w-1/2"></div>
              </div>
              <div className="h-6 bg-stone-100 rounded-full w-20"></div>
            </div>
            <div className="mt-3 space-y-2">
              <div className="h-3 bg-stone-100 rounded w-full"></div>
              <div className="h-3 bg-stone-100 rounded w-2/3"></div>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="h-4 bg-stone-100 rounded w-24"></div>
              <div className="h-4 bg-stone-100 rounded w-16"></div>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function PoolsView({ user, initial }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<PoolListItem[]>(initial);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<PoolStatus | "all">("all");
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return items.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!ql) return true;
      const blob = [
        p.name,
        p.agency,
        p.jurisdiction,
        p.playType,
        p.fitSummary,
        p.nextAction,
        p.tags.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(ql);
    });
  }, [items, q, statusFilter]);

  async function seedFromMaster() {
    setSeeding(true);
    setLoading(true);
    setSeedMsg(null);
    try {
      const res = await fetch("/api/pools/seed", { method: "POST" });
      const data = (await res.json()) as { seeded: number; existing: number; error?: string };
      if (!res.ok) {
        setSeedMsg(`Seed failed: ${data.error ?? res.statusText}`);
      } else if (data.seeded === 0) {
        setSeedMsg(`Library already has ${data.existing} pool${data.existing === 1 ? "" : "s"}.`);
      } else {
        setSeedMsg(`Seeded ${data.seeded} pool${data.seeded === 1 ? "" : "s"} from master list.`);
        router.refresh();
      }
    } catch (err) {
      setSeedMsg(`Seed failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSeeding(false);
      setLoading(false);
    }
  }

  async function scanUnderspend() {
    setScanning(true);
    setLoading(true);
    setSeedMsg(null);
    try {
      const res = await fetch("/api/cron/underspend-scan", { method: "POST" });
      const data = (await res.json()) as {
        found?: number;
        ranked?: number;
        created?: number;
        updated?: number;
        error?: string;
      };
      if (!res.ok) {
        setSeedMsg(`Underspend scan failed: ${data.error ?? res.statusText}`);
      } else if ((data.ranked ?? 0) === 0) {
        setSeedMsg(`Underspend scan ran — ${data.found ?? 0} balances found, none cleared the threshold.`);
      } else {
        setSeedMsg(
          `Underspend scan: ${data.created ?? 0} new + ${data.updated ?? 0} refreshed pool(s) from ${data.ranked} ranked balances.`,
        );
        router.refresh();
      }
    } catch (err) {
      setSeedMsg(`Underspend scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
      setLoading(false);
    }
  }

  async function quickStatus(id: string, status: PoolStatus) {
    const prev = items;
    setItems((s) => s.map((p) => (p.id === id ? { ...p, status } : p)));
    const res = await fetch(`/api/pools/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) setItems(prev);
  }

  const counts = useMemo(() => {
    const c: Record<PoolStatus | "all", number> = {
      all: items.length,
      discovered: 0,
      researched: 0,
      engaged: 0,
      "in-proposal": 0,
      won: 0,
      lost: 0,
    };
    for (const p of items) c[p.status] += 1;
    return c;
  }, [items]);

  return (
    <div className="mx-auto max-w-6xl px-6 pt-3">
      <AppHeader
        tagline="Funding pools"
        title={`${items.length} pool${items.length === 1 ? "" : "s"} tracked`}
        subtitle="Appropriated-but-undisbursed money where deadlines force disbursement."
        userLabel={user.name}
        activeNav="pools"
        trailingActions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => void scanUnderspend()}
              disabled={scanning || seeding}
              className="rounded-md border border-emerald-700 bg-emerald-700 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
              title="Pull unspent federal-account balances (USASpending.gov) and rank by underspend"
            >
              {scanning ? "Scanning…" : "Scan unspent funds"}
            </button>
            <button
              onClick={() => void seedFromMaster()}
              disabled={seeding || scanning}
              className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              {seeding ? "Seeding…" : "Seed from master list"}
            </button>
          </div>
        }
      />

      <div className="mt-4 flex flex-col gap-4">
        <PageInfo id="pools" title="What are Pools?">
          <p>
            <strong>Yes — this is the unallocated-money page.</strong> A pool is a pot of funding worth chasing that isn&rsquo;t a
            normal open application: <strong>unspent federal balances</strong> (money agencies were given but never obligated —
            use-it-or-lose-it), <strong>opioid-settlement funds</strong> distributed by state and county boards, and hand-tracked
            strategic pots.
          </p>
          <p>
            <strong>Use it:</strong> hit <em>Scan unspent funds</em> to refresh discoveries, then move each pool through its
            pipeline — discovered → researched → engaged → in-proposal. Re-scans update the numbers but never overwrite your
            notes or status. The play is usually a direct approach to the program office, not an application form.
          </p>
        </PageInfo>
        <SuggestionInbox paneContextType="pools" />
        {seedMsg && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            {seedMsg}
          </div>
        )}

        <section className="flex flex-wrap items-end gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <div className="grow">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Search</label>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name, agency, jurisdiction, fit, tags…"
              className={`mt-1 block w-full ${INPUT}`}
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Status</label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <StatusChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
                All <span className="opacity-60">({counts.all})</span>
              </StatusChip>
              {POOL_STATUSES.map((s) => (
                <StatusChip
                  key={s}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                >
                  {s} <span className="opacity-60">({counts[s]})</span>
                </StatusChip>
              ))}
            </div>
          </div>
        </section>

        {loading ? (
          <div className="space-y-3 pb-12">
            <PoolsSkeleton />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center">
            {items.length === 0 ? (
              <>
                <p className="text-sm font-medium text-stone-800">No funding pools yet.</p>
                <p className="mt-2 text-xs leading-5 text-stone-500">
                  Click <em>Seed from master list</em> above to load the sample pool list.
                </p>
              </>
            ) : (
              <p className="text-sm text-stone-700">No pools match your filter.</p>
            )}
          </div>
        ) : (
          <ul className="space-y-3 pb-12">
            {filtered.map((p) => (
              <PoolRow key={p.id} pool={p} onStatusChange={quickStatus} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusChip({
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

function PoolRow({
  pool,
  onStatusChange,
}: {
  pool: PoolListItem;
  onStatusChange: (id: string, status: PoolStatus) => void | Promise<void>;
}) {
  return (
    <li className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {pool.rank != null && (
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
                {pool.rank}
              </span>
            )}
            <Link
              href={`/pools/${pool.id}`}
              className="truncate text-base font-semibold text-emerald-700 hover:underline"
            >
              {pool.name}
            </Link>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[pool.status]}`}
            >
              {pool.status}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-500">
            {pool.agency && <span>{pool.agency}</span>}
            {pool.jurisdiction && <span>· {pool.jurisdiction}</span>}
            {pool.playType && <span>· {pool.playType}</span>}
          </div>
          {pool.fitSummary && (
            <p className="mt-1.5 line-clamp-2 text-sm leading-6 text-stone-700">{pool.fitSummary}</p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-stone-600">
            {pool.allocatedAmount && <span>Allocated: <strong>{pool.allocatedAmount}</strong></span>}
            {pool.unspentAmount && <span>Unspent: <strong>{pool.unspentAmount}</strong></span>}
            {(pool.deadlineDate || pool.deadlineLabel) && (
              <span>
                Deadline: <strong>{pool.deadlineDate ?? pool.deadlineLabel}</strong>
              </span>
            )}
            <span className="ml-auto text-stone-400">updated {fmtDate(pool.updatedAt)}</span>
          </div>
          {pool.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {pool.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <select
            value={pool.status}
            onChange={(e) => void onStatusChange(pool.id, e.target.value as PoolStatus)}
            className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 shadow-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600/30"
          >
            {POOL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Link
            href={`/pools/${pool.id}`}
            className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
          >
            Open →
          </Link>
        </div>
      </div>
    </li>
  );
}
