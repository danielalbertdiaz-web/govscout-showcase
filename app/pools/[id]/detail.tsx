"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/app/_components/AppHeader";
import { POOL_STATUSES, type FundingPool, type PoolStatus } from "@/lib/pools-types";
import { PoolActivationPanel } from "./activation-panel";

export type LinkedDraft = { id: string; title: string; updatedAt: number };

type Props = {
  user: { email: string; name: string };
  pool: FundingPool;
  linkedDrafts: LinkedDraft[];
};

const INPUT =
  "rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 shadow-sm placeholder:text-stone-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/20";

const TEXTAREA = `${INPUT} min-h-[80px] leading-6 resize-y`;

const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-stone-600";

const STATUS_PILL: Record<PoolStatus, string> = {
  discovered: "border-stone-300 bg-stone-50 text-stone-700",
  researched: "border-sky-300 bg-sky-50 text-sky-800",
  engaged: "border-amber-300 bg-amber-50 text-amber-900",
  "in-proposal": "border-emerald-300 bg-emerald-50 text-emerald-800",
  won: "border-emerald-500 bg-emerald-600 text-white",
  lost: "border-stone-400 bg-stone-200 text-stone-700",
};

function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}

type FormState = {
  name: string;
  status: PoolStatus;
  agency: string;
  jurisdiction: string;
  playType: string;
  allocatedAmount: string;
  unspentAmount: string;
  deadlineDate: string;
  deadlineLabel: string;
  fitSummary: string;
  wedge: string;
  nextAction: string;
  notes: string;
  tags: string;
};

function poolToForm(p: FundingPool): FormState {
  return {
    name: p.name,
    status: p.status,
    agency: p.agency ?? "",
    jurisdiction: p.jurisdiction ?? "",
    playType: p.playType ?? "",
    allocatedAmount: p.allocatedAmount ?? "",
    unspentAmount: p.unspentAmount ?? "",
    deadlineDate: p.deadlineDate ?? "",
    deadlineLabel: p.deadlineLabel ?? "",
    fitSummary: p.fitSummary ?? "",
    wedge: p.wedge ?? "",
    nextAction: p.nextAction ?? "",
    notes: p.notes ?? "",
    tags: p.tags.join(", "),
  };
}

export default function PoolDetail({ user, pool: initialPool, linkedDrafts }: Props) {
  const router = useRouter();
  const [pool, setPool] = useState(initialPool);
  const [form, setForm] = useState<FormState>(poolToForm(initialPool));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = JSON.stringify(form) !== JSON.stringify(poolToForm(pool));

  function patchForm<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      status: form.status,
      agency: form.agency.trim() || null,
      jurisdiction: form.jurisdiction.trim() || null,
      playType: form.playType.trim() || null,
      allocatedAmount: form.allocatedAmount.trim() || null,
      unspentAmount: form.unspentAmount.trim() || null,
      deadlineDate: form.deadlineDate.trim() || null,
      deadlineLabel: form.deadlineLabel.trim() || null,
      fitSummary: form.fitSummary.trim() || null,
      wedge: form.wedge.trim() || null,
      nextAction: form.nextAction.trim() || null,
      notes: form.notes.trim() || null,
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
    try {
      const res = await fetch(`/api/pools/${pool.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { pool?: FundingPool; error?: string };
      if (!res.ok || !data.pool) {
        setError(data.error ?? `Save failed (${res.status})`);
      } else {
        setPool(data.pool);
        setForm(poolToForm(data.pool));
        setSavedAt(Date.now());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete pool "${pool.name}"? Drafts linked to it stay but lose the link.`)) return;
    const res = await fetch(`/api/pools/${pool.id}`, { method: "DELETE" });
    if (res.ok) router.push("/pools");
  }

  return (
    <div className="mx-auto max-w-4xl px-6 pt-3">
      <AppHeader
        tagline="Funding pool · detail"
        title={pool.name}
        subtitle={[pool.agency, pool.jurisdiction].filter(Boolean).join(" · ")}
        userLabel={user.name}
        activeNav="pools"
        trailingActions={
          <button
            type="button"
            onClick={() => void remove()}
            className="rounded-md border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
        }
      />

      <div className="mt-4 mb-12 flex flex-col gap-4">
        <div className="flex items-center gap-3 text-xs text-stone-600">
          <Link href="/pools" className="font-medium text-emerald-700 hover:underline">
            ← Pools
          </Link>
          <span className="text-stone-300">·</span>
          <span>Created {fmtDate(pool.createdAt)}</span>
          <span className="text-stone-300">·</span>
          <span>Updated {fmtDate(pool.updatedAt)}</span>
          <span
            className={`ml-2 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_PILL[pool.status]}`}
          >
            {pool.status}
          </span>
        </div>

        <section className="grid grid-cols-1 gap-4 rounded-xl border border-stone-200 bg-white p-4 shadow-sm md:grid-cols-2">
          <Field label="Name">
            <input
              type="text"
              value={form.name}
              onChange={(e) => patchForm("name", e.target.value)}
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) => patchForm("status", e.target.value as PoolStatus)}
              className={`block w-full ${INPUT}`}
            >
              {POOL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agency">
            <input
              type="text"
              value={form.agency}
              onChange={(e) => patchForm("agency", e.target.value)}
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Jurisdiction">
            <input
              type="text"
              value={form.jurisdiction}
              onChange={(e) => patchForm("jurisdiction", e.target.value)}
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Play type">
            <input
              type="text"
              value={form.playType}
              onChange={(e) => patchForm("playType", e.target.value)}
              placeholder="Direct, B2G service line, …"
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Allocated $">
            <input
              type="text"
              value={form.allocatedAmount}
              onChange={(e) => patchForm("allocatedAmount", e.target.value)}
              placeholder="$1.19M"
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Unspent $">
            <input
              type="text"
              value={form.unspentAmount}
              onChange={(e) => patchForm("unspentAmount", e.target.value)}
              placeholder="$1.18M (98.6%)"
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Deadline (ISO date)">
            <input
              type="date"
              value={form.deadlineDate}
              onChange={(e) => patchForm("deadlineDate", e.target.value)}
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Deadline label">
            <input
              type="text"
              value={form.deadlineLabel}
              onChange={(e) => patchForm("deadlineLabel", e.target.value)}
              placeholder="Rolling, FY27 open now, …"
              className={`block w-full ${INPUT}`}
            />
          </Field>
          <Field label="Tags (comma-separated)">
            <input
              type="text"
              value={form.tags}
              onChange={(e) => patchForm("tags", e.target.value)}
              placeholder="opioid, behavioral-health, …"
              className={`block w-full ${INPUT}`}
            />
          </Field>
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <Field label="Fit summary">
            <textarea
              value={form.fitSummary}
              onChange={(e) => patchForm("fitSummary", e.target.value)}
              className={`block w-full ${TEXTAREA}`}
            />
          </Field>
          <div className="h-3" />
          <Field label="Wedge">
            <textarea
              value={form.wedge}
              onChange={(e) => patchForm("wedge", e.target.value)}
              className={`block w-full ${TEXTAREA}`}
            />
          </Field>
          <div className="h-3" />
          <Field label="Next action">
            <textarea
              value={form.nextAction}
              onChange={(e) => patchForm("nextAction", e.target.value)}
              className={`block w-full ${TEXTAREA}`}
            />
          </Field>
          <div className="h-3" />
          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => patchForm("notes", e.target.value)}
              className={`block w-full ${TEXTAREA} min-h-[140px]`}
            />
          </Field>
        </section>

        <PoolActivationPanel poolId={pool.id} />

        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
          <h2 className={LABEL}>Linked drafts ({linkedDrafts.length})</h2>
          {linkedDrafts.length === 0 ? (
            <p className="mt-2 text-xs text-stone-500">
              No drafts linked to this pool yet. Drafts can be linked from the draft API by passing{" "}
              <code className="rounded bg-stone-100 px-1 py-0.5 text-[11px]">poolId</code>.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {linkedDrafts.map((d) => (
                <li key={d.id} className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-sm">
                  <Link href={`/drafts/${d.id}`} className="truncate font-medium text-emerald-700 hover:underline">
                    {d.title || d.id}
                  </Link>
                  <span className="text-xs text-stone-500">{fmtDate(d.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="sticky bottom-3 z-20 flex items-center justify-end gap-3 rounded-xl border border-stone-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          {error && <span className="text-xs text-red-700">{error}</span>}
          {savedAt && !dirty && !error && (
            <span className="text-xs text-stone-500">Saved {fmtDate(savedAt)}</span>
          )}
          <button
            type="button"
            onClick={() => setForm(poolToForm(pool))}
            disabled={!dirty || saving}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            Revert
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
