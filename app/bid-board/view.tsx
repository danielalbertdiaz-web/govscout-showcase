"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/app/_components/AppHeader";
import { PageInfo } from "@/app/_components/PageInfo";
import {
  CLIENT_IDS,
  CLIENT_LABELS,
  FP_BOARD_GROUPS,
  FP_OPEN_STATUSES,
  FP_STATUS_LABELS,
  FP_PRICE_BANDS,
  FP_TIERS,
  fpPriceBand,
  type ClientId,
  type FpOpportunity,
  type FpEvent,
  type FpStatus,
  type FpTier,
} from "@/lib/federal-pipeline-types";

type Props = {
  user: { email: string; name: string };
  /** Which client's panel this is — rows arrive already scoped by the route. */
  client: ClientId;
  opportunities: FpOpportunity[];
  /** Latest CO-contact-ish event per opp id (co_reply, qa_answered, amendment, award). */
  lastContact: Record<string, FpEvent>;
  /** Latest submitted event per opp id. */
  lastSubmitted: Record<string, FpEvent>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Statuses that mean "a priced package went out the door" — the scoreboard's
// submitted universe.
const SUBMITTED_UNIVERSE: readonly FpStatus[] = [
  "submitted",
  "qa_open",
  "closed_won",
  "closed_lost",
  "closed_no_award",
];
const DECIDED: readonly FpStatus[] = ["closed_won", "closed_lost", "closed_no_award"];

const fmtUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

// Deadline vocabulary lives in lib/deadline.ts (D-1) — shared with the
// unified /opportunities view so "past due" cannot drift between screens.
// Re-exported because tests/bid-board-view.test.ts pins it via this module.
export { deadlineText } from "@/lib/deadline";
import { deadlineText, deadlineTone, hoursLeft } from "@/lib/deadline";
// Card/column markup is shared with /opportunities (cleanup task 3) — one
// definition, identity-pinned in tests/bid-board-view.test.ts.
export { PipelineCard, PipelineColumn } from "@/app/_components/PipelineBoard";
import { PipelineCard, PipelineColumn } from "@/app/_components/PipelineBoard";

function fmtDeadlineStamp(deadline: string): string {
  const d = new Date(deadline);
  if (!Number.isFinite(d.getTime())) return deadline;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "America/New_York",
  });
}

function eventLabel(ev: FpEvent): string {
  const labels: Record<string, string> = {
    co_reply_received: "CO reply",
    qa_answered: "Q&A answered",
    amendment_posted: "Amendment",
    award_posted: "Award posted",
  };
  return labels[ev.kind] ?? ev.kind.replace(/_/g, " ");
}

function daysSince(ts: number): number {
  return Math.floor((Date.now() - ts) / DAY_MS);
}

function daysAgo(ts: number): string {
  const d = Math.floor((Date.now() - ts) / DAY_MS);
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  return `${d} days ago`;
}

// --- Scoreboard math (pure; derived from props) ----------------------------

/**
 * Header record segment. "0W–0L–0NA" is arithmetically true before any
 * outcome is recorded, but reads as a broken counter — say so in words
 * until a first outcome exists. Exported for tests.
 */
export function recordText(won: number, lost: number, noAward: number): string {
  if (won === 0 && lost === 0 && noAward === 0) return "no outcomes recorded yet";
  return `record ${won}W–${lost}L–${noAward}NA`;
}

type HitRow = { key: string; submitted: number; decided: number; won: number };

function hitRates(opps: FpOpportunity[], keyOf: (o: FpOpportunity) => string | null): HitRow[] {
  const rows = new Map<string, HitRow>();
  for (const o of opps) {
    if (!SUBMITTED_UNIVERSE.includes(o.status)) continue;
    const key = keyOf(o);
    if (!key) continue;
    const row = rows.get(key) ?? { key, submitted: 0, decided: 0, won: 0 };
    row.submitted += 1;
    if (DECIDED.includes(o.status)) row.decided += 1;
    if (o.status === "closed_won") row.won += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.submitted - a.submitted).slice(0, 8);
}

// --- Small building blocks -------------------------------------------------

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">{title}</h2>
      {hint ? <span className="text-xs text-stone-400">{hint}</span> : null}
    </div>
  );
}

function OppCard({
  opp,
  onEdit,
  onDelete,
  onToggleFlag,
  flagBusy,
  onDragStart,
  onDragEnd,
}: {
  opp: FpOpportunity;
  onEdit: (opp: FpOpportunity) => void;
  onDelete: (opp: FpOpportunity) => void;
  onToggleFlag: (opp: FpOpportunity) => void;
  flagBusy: boolean;
  onDragStart: (opp: FpOpportunity, e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const h = hoursLeft(opp.responseDeadline);
  const price = opp.status === "closed_won" ? (opp.resultAwardAmount ?? opp.priceQuoted) : opp.priceQuoted;
  const flagged = opp.flaggedAt != null;
  return (
    <PipelineCard
      draggable
      onDragStart={(e) => onDragStart(opp, e)}
      onDragEnd={onDragEnd}
      title={opp.title}
      subtitle={
        <>
          {opp.agency ?? "—"}
          {opp.solNumber ? <span className="text-stone-400"> · {opp.solNumber}</span> : null}
        </>
      }
      right={
        price != null ? (
          <div className="shrink-0 text-[13px] font-semibold tabular-nums text-stone-800">{fmtUsd.format(price)}</div>
        ) : undefined
      }
      deadlineLabel={deadlineText(opp.responseDeadline)}
      deadlineClass={deadlineTone(h)}
      badges={
        <span className="flex items-center gap-1">
          {flagged ? (
            <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
              Flagged
            </span>
          ) : null}
          <span className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-500">
            {FP_STATUS_LABELS[opp.status]}
          </span>
        </span>
      }
      footer={
        <div className="mt-2 flex items-center gap-1.5 border-t border-stone-100 pt-1.5">
          <button
            type="button"
            onClick={() => onToggleFlag(opp)}
            disabled={flagBusy}
            className={`rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-60 ${
              flagged
                ? "border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400"
                : "border-stone-200 text-stone-500 hover:border-amber-300 hover:text-amber-800"
            }`}
          >
            {flagged ? "Unflag" : "Flag"}
          </button>
          <button
            type="button"
            onClick={() => onEdit(opp)}
            className="rounded border border-stone-200 px-1.5 py-0.5 text-[11px] text-stone-500 hover:border-stone-300 hover:text-stone-700"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(opp)}
            className="rounded border border-stone-200 px-1.5 py-0.5 text-[11px] text-stone-500 hover:border-red-300 hover:text-red-700"
          >
            Delete
          </button>
        </div>
      }
    />
  );
}

// --- Kanban drag-and-drop (2026-08-13, pulled forward from Phase 1) ----------

/**
 * The statuses a card dropped on a column may take — exactly the column's own
 * status list from FP_BOARD_GROUPS, no new vocabulary. A single-status column
 * applies immediately on drop; a multi-status column (Triage, Closed) opens a
 * chooser, because "dropped on Closed" cannot guess won vs lost vs no-award.
 * Exported for tests.
 */
export function dropStatusesFor(groupKey: string): readonly FpStatus[] {
  return FP_BOARD_GROUPS.find((g) => g.key === groupKey)?.statuses ?? [];
}

function MoveChooserDialog({
  opp,
  groupLabel,
  statuses,
  busy,
  error,
  onPick,
  onClose,
}: {
  opp: FpOpportunity;
  groupLabel: string;
  statuses: readonly FpStatus[];
  busy: boolean;
  error: string | null;
  onPick: (status: FpStatus) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-stone-900/40 p-4 pt-24">
      <div className="gs-card w-full max-w-md bg-white p-4">
        <h3 className="text-sm font-semibold text-stone-900">Move to {groupLabel} — as what?</h3>
        <p className="mt-1 line-clamp-2 text-xs text-stone-500" title={opp.title}>
          {opp.title}
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {statuses.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy || s === opp.status}
              onClick={() => onPick(s)}
              className={`rounded border px-3 py-2 text-left text-[13px] disabled:opacity-50 ${
                s === opp.status
                  ? "border-stone-200 bg-stone-50 text-stone-400"
                  : "border-stone-200 text-stone-800 hover:border-emerald-400 hover:bg-emerald-50"
              }`}
            >
              {FP_STATUS_LABELS[s]}
              {s === opp.status ? <span className="ml-2 text-[11px]">(current)</span> : null}
            </button>
          ))}
        </div>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:border-stone-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Edit + permanent delete (migration 036) --------------------------------

// Board-editable fields. Identity/provenance (id, sol number, notice id,
// created) are shown read-only in the dialog and never sent.
type EditForm = {
  title: string;
  agency: string;
  office: string;
  naics: string;
  setAside: string;
  noticeType: string;
  tier: FpTier | "";
  url: string;
  responseDeadline: string;
  priceQuoted: string;
  priceBasis: string;
  nobidReason: string;
};

function toEditForm(o: FpOpportunity): EditForm {
  return {
    title: o.title,
    agency: o.agency ?? "",
    office: o.office ?? "",
    naics: o.naics ?? "",
    setAside: o.setAside ?? "",
    noticeType: o.noticeType ?? "",
    tier: o.tier ?? "",
    url: o.url ?? "",
    responseDeadline: o.responseDeadline ?? "",
    priceQuoted: o.priceQuoted == null ? "" : String(o.priceQuoted),
    priceBasis: o.priceBasis ?? "",
    nobidReason: o.nobidReason ?? "",
  };
}

const nullable = (s: string) => (s.trim() ? s.trim() : null);

function TextField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label className="block text-xs">
      <span className="font-medium text-stone-600">{label}</span>
      {hint ? <span className="ml-1 text-stone-400">{hint}</span> : null}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-stone-200 px-2 py-1.5 text-[13px] text-stone-900 focus:border-stone-400 focus:outline-none"
      />
    </label>
  );
}

function EditDialog({
  opp,
  onClose,
  onSaved,
}: {
  opp: FpOpportunity;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<EditForm>(() => toEditForm(opp));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof EditForm) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  async function save() {
    if (!form.title.trim()) {
      setError("Title cannot be empty.");
      return;
    }
    const priceRaw = form.priceQuoted.trim();
    const price = priceRaw ? Number(priceRaw.replace(/[$,\s]/g, "")) : null;
    if (price != null && !Number.isFinite(price)) {
      setError("Price quoted must be a number (or blank).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bid-board/${opp.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          agency: nullable(form.agency),
          office: nullable(form.office),
          naics: nullable(form.naics),
          setAside: nullable(form.setAside),
          noticeType: nullable(form.noticeType),
          tier: form.tier || null,
          url: nullable(form.url),
          responseDeadline: nullable(form.responseDeadline),
          priceQuoted: price,
          priceBasis: nullable(form.priceBasis),
          nobidReason: nullable(form.nobidReason),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `save failed (${res.status})`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/40 p-4 pt-12">
      <div className="gs-card w-full max-w-lg bg-white p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-stone-900">Edit opportunity</h3>
          <span className="truncate text-[11px] text-stone-400" title={opp.id}>
            {opp.solNumber ?? opp.noticeId ?? opp.id} · not editable
          </span>
        </div>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextField label="Title" value={form.title} onChange={set("title")} />
          </div>
          <TextField label="Agency" value={form.agency} onChange={set("agency")} />
          <TextField label="Office" value={form.office} onChange={set("office")} />
          <TextField label="NAICS" value={form.naics} onChange={set("naics")} hint="comma-separated" />
          <TextField label="Set-aside" value={form.setAside} onChange={set("setAside")} />
          <TextField label="Notice type" value={form.noticeType} onChange={set("noticeType")} />
          <label className="block text-xs">
            <span className="font-medium text-stone-600">Tier</span>
            <select
              value={form.tier}
              onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value as FpTier | "" }))}
              className="mt-1 w-full rounded border border-stone-200 bg-white px-2 py-1.5 text-[13px] text-stone-900 focus:border-stone-400 focus:outline-none"
            >
              <option value="">none</option>
              {FP_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2">
            <TextField label="Notice URL" value={form.url} onChange={set("url")} />
          </div>
          <div className="sm:col-span-2">
            <TextField
              label="Response deadline"
              value={form.responseDeadline}
              onChange={set("responseDeadline")}
              hint="ISO 8601, e.g. 2026-08-15T17:00:00-04:00"
            />
          </div>
          <TextField label="Price quoted (USD)" value={form.priceQuoted} onChange={set("priceQuoted")} />
          <TextField label="Price basis" value={form.priceBasis} onChange={set("priceBasis")} />
          <div className="sm:col-span-2">
            <TextField label="No-bid reason" value={form.nobidReason} onChange={set("nobidReason")} />
          </div>
        </div>
        {error ? <p className="mt-3 text-xs text-red-600">{error}</p> : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:border-stone-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmDialog({
  opp,
  onClose,
  onDeleted,
}: {
  opp: FpOpportunity;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bid-board/${opp.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `delete failed (${res.status})`);
      }
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-stone-900/40 p-4 pt-24">
      <div className="gs-card w-full max-w-md bg-white p-4">
        <h3 className="text-sm font-semibold text-stone-900">Permanently delete this opportunity?</h3>
        <p className="mt-2 text-xs text-stone-600">
          <span className="font-medium text-stone-800">{opp.title}</span> will be permanently
          deleted, along with its event history. It will <span className="font-semibold">not</span>{" "}
          come back on future scans, and this <span className="font-semibold">cannot be undone</span>.
        </p>
        <label className="mt-3 block text-xs">
          <span className="font-medium text-stone-600">Reason</span>
          <span className="ml-1 text-stone-400">optional — recorded so the removal explains itself later</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded border border-stone-200 px-2 py-1.5 text-[13px] text-stone-900 focus:border-stone-400 focus:outline-none"
          />
        </label>
        {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:border-stone-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doDelete}
            disabled={busy}
            className="rounded border border-red-600 bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- The pane --------------------------------------------------------------

// Panel switcher — a navigation between separate server-scoped pages, not a
// client-side filter: switching panels refetches under the other client_id.
function PanelTabs({ current }: { current: ClientId }) {
  return (
    <div className="flex items-center gap-1">
      {CLIENT_IDS.map((c) => (
        <a
          key={c}
          href={`/bid-board/${c}`}
          aria-current={c === current ? "page" : undefined}
          className={`rounded border px-2.5 py-1 text-xs font-medium ${
            c === current
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-stone-200 text-stone-600 hover:border-stone-300 hover:text-stone-800"
          }`}
        >
          {CLIENT_LABELS[c]}
        </a>
      ))}
    </div>
  );
}

export default function BidBoardView({ user, client, opportunities, lastContact, lastSubmitted }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<FpOpportunity | null>(null);
  const [deleting, setDeleting] = useState<FpOpportunity | null>(null);
  const [flagBusyId, setFlagBusyId] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);

  // Kanban drag state. The dragged opp is held in React state (not just
  // dataTransfer) because dragover events cannot read dataTransfer contents.
  const [dragging, setDragging] = useState<FpOpportunity | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [chooser, setChooser] = useState<{ opp: FpOpportunity; groupKey: string; groupLabel: string } | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // The one write path for a board move: PATCH { status } goes through
  // setFpStatus server-side, so the trail event lands with the status.
  async function applyMove(opp: FpOpportunity, status: FpStatus) {
    setMoveBusy(true);
    setMoveError(null);
    try {
      const res = await fetch(`/api/bid-board/${opp.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `move failed (${res.status})`);
      }
      setChooser(null);
      router.refresh();
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setMoveBusy(false);
    }
  }

  function handleDrop(groupKey: string, groupLabel: string) {
    setDropTarget(null);
    const opp = dragging;
    setDragging(null);
    if (!opp) return;
    const targets = dropStatusesFor(groupKey);
    if (targets.length === 0 || (targets as readonly string[]).includes(opp.status)) return; // same column: no-op
    if (targets.length === 1) {
      void applyMove(opp, targets[0]);
    } else {
      setMoveError(null);
      setChooser({ opp, groupKey, groupLabel });
    }
  }

  // One-click toggle, no dialog: flagging is reversible (unlike delete) and
  // carries no free text. The server records who/when on the event trail.
  async function toggleFlag(opp: FpOpportunity) {
    setFlagBusyId(opp.id);
    setFlagError(null);
    try {
      const res = await fetch(`/api/bid-board/${opp.id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged: opp.flaggedAt == null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `flag failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setFlagError(err instanceof Error ? err.message : String(err));
    } finally {
      setFlagBusyId(null);
    }
  }

  const open = useMemo(
    () => opportunities.filter((o) => FP_OPEN_STATUSES.includes(o.status)),
    [opportunities],
  );

  const columns = useMemo(
    () =>
      FP_BOARD_GROUPS.map((g) => ({
        ...g,
        opps: opportunities.filter((o) => (g.statuses as readonly FpStatus[]).includes(o.status)),
      })),
    [opportunities],
  );

  const deadline14 = useMemo(
    () =>
      open
        .filter((o) => {
          const h = hoursLeft(o.responseDeadline);
          return h !== null && h > 0 && h <= 14 * 24;
        })
        .sort((a, b) => (a.responseDeadline! < b.responseDeadline! ? -1 : 1)),
    [open],
  );

  const scoreboard = useMemo(() => {
    const won = opportunities.filter((o) => o.status === "closed_won");
    const lost = opportunities.filter((o) => o.status === "closed_lost");
    const noAward = opportunities.filter((o) => o.status === "closed_no_award");
    const submittedUniverse = opportunities.filter((o) => SUBMITTED_UNIVERSE.includes(o.status));
    const totalSubmitted = submittedUniverse.reduce((s, o) => s + (o.priceQuoted ?? 0), 0);
    const totalWon = won.reduce((s, o) => s + (o.resultAwardAmount ?? o.priceQuoted ?? 0), 0);
    return {
      won: won.length,
      lost: lost.length,
      noAward: noAward.length,
      totalSubmitted,
      totalWon,
      byAgency: hitRates(opportunities, (o) => o.agency),
      byNaics: hitRates(opportunities, (o) => o.naics?.split(",")[0]?.trim() || null),
      byBand: hitRates(opportunities, (o) => fpPriceBand(o.priceQuoted)),
    };
  }, [opportunities]);

  // Plain render-time computation (not useMemo) because the day math reads the
  // clock; same pattern as the contracts pane's deadline helpers.
  const submittedOut = opportunities
    .filter((o) => o.status === "submitted" || o.status === "qa_open")
    .map((o) => {
      const subTs = lastSubmitted[o.id]?.ts ?? o.updatedAt;
      return { opp: o, days: daysSince(subTs), contact: lastContact[o.id] ?? null };
    })
    .sort((a, b) => b.days - a.days);
  const waiting = [
    { label: "3+ weeks out", items: submittedOut.filter((s) => s.days >= 22) },
    { label: "1–3 weeks", items: submittedOut.filter((s) => s.days >= 8 && s.days < 22) },
    { label: "This week", items: submittedOut.filter((s) => s.days < 8) },
  ].filter((b) => b.items.length > 0);

  const radar = useMemo(
    () =>
      opportunities
        .filter((o) => o.status === "triaged_watch")
        .sort((a, b) => {
          if (!a.responseDeadline) return 1;
          if (!b.responseDeadline) return -1;
          return a.responseDeadline < b.responseDeadline ? -1 : 1;
        }),
    [opportunities],
  );

  return (
    <div className="mx-auto max-w-7xl px-6 pt-3">
      <AppHeader
        tagline="Federal Pipeline"
        title={`Bid Board — ${CLIENT_LABELS[client]}`}
        subtitle={`${open.length} open · ${opportunities.length} tracked · ${recordText(scoreboard.won, scoreboard.lost, scoreboard.noAward)}`}
        userLabel={user.name}
      />

      <div className="mt-4 flex flex-col gap-6 pb-16">
        <div className="flex items-center justify-between gap-3">
          <PanelTabs current={client} />
          <span className="text-xs text-stone-400">
            {CLIENT_LABELS[client]} panel — rows tracked for other clients never appear here
          </span>
        </div>
        <PageInfo id="bid-board" title="What is the Bid Board?">
          <p>
            The live contract pipeline for the {CLIENT_LABELS[client]} panel. Each client&apos;s panel
            is corpus-isolated (PANEL_ISOLATION_SPEC.md): discovery crons ingest with an explicit
            client, and a panel only ever reads its own client&apos;s rows. Alfred updates statuses,
            deadlines, and events from scans, submissions, and SAM.gov amendment watches; this board is
            the single place to see what&apos;s moving and what&apos;s waiting on the operator.
          </p>
        </PageInfo>

        {/* 1 — Pipeline board */}
        <section>
          <SectionTitle title="Pipeline" hint="drag a card to move it · flagged first, then by deadline" />
          {flagError ? <p className="mt-1 text-xs text-red-600">{flagError}</p> : null}
          {moveError && !chooser ? <p className="mt-1 text-xs text-red-600">Move failed: {moveError}</p> : null}
          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {columns.map((col) => (
              <PipelineColumn
                key={col.key}
                label={col.label}
                count={col.opps.length}
                dropActive={dropTarget === col.key && dragging != null}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault(); // required — without it the browser refuses the drop
                  e.dataTransfer.dropEffect = "move";
                  setDropTarget(col.key);
                }}
                onDragLeave={() => setDropTarget((t) => (t === col.key ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(col.key, col.label);
                }}
              >
                {col.opps.map((o) => (
                  <OppCard
                    key={o.id}
                    opp={o}
                    onEdit={setEditing}
                    onDelete={setDeleting}
                    onToggleFlag={toggleFlag}
                    flagBusy={flagBusyId === o.id}
                    onDragStart={(opp, e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", opp.id);
                      setDragging(opp);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  />
                ))}
              </PipelineColumn>
            ))}
          </div>
        </section>

        {/* 2 — Deadline strip */}
        <section>
          <SectionTitle title="Next 14 days" hint="response deadlines across open opportunities" />
          {deadline14.length === 0 ? (
            <p className="mt-2 text-sm text-stone-400">No deadlines in the next two weeks.</p>
          ) : (
            <div className="mt-2 flex gap-3 overflow-x-auto pb-1">
              {deadline14.map((o) => {
                const h = hoursLeft(o.responseDeadline);
                return (
                  <div key={o.id} className="gs-card w-64 shrink-0 p-3">
                    <div className={`text-xs ${deadlineTone(h)}`}>{fmtDeadlineStamp(o.responseDeadline!)}</div>
                    <div className="mt-1 line-clamp-2 text-[13px] font-medium text-stone-900" title={o.title}>
                      {o.title}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-xs text-stone-500">
                      <span className="truncate">{o.agency ?? o.solNumber ?? "—"}</span>
                      <span className="shrink-0 rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px]">
                        {FP_STATUS_LABELS[o.status]}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 3 — Scoreboard */}
        <section>
          <SectionTitle title="Scoreboard" hint="submitted universe = anything that went out the door" />
          <div className="mt-2 grid gap-3 md:grid-cols-4">
            <div className="gs-card p-4">
              <div className="text-xs uppercase tracking-wide text-stone-400">Record</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                {scoreboard.won}–{scoreboard.lost}–{scoreboard.noAward}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">win – loss – no award</div>
            </div>
            <div className="gs-card p-4">
              <div className="text-xs uppercase tracking-wide text-stone-400">Total submitted</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                {fmtUsd.format(scoreboard.totalSubmitted)}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">quoted value, all submissions</div>
            </div>
            <div className="gs-card p-4">
              <div className="text-xs uppercase tracking-wide text-stone-400">Total won</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-700">
                {fmtUsd.format(scoreboard.totalWon)}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">award value of closed-won</div>
            </div>
            <div className="gs-card p-4">
              <div className="text-xs uppercase tracking-wide text-stone-400">Hit rate</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
                {scoreboard.won + scoreboard.lost + scoreboard.noAward > 0
                  ? `${Math.round((scoreboard.won / (scoreboard.won + scoreboard.lost + scoreboard.noAward)) * 100)}%`
                  : "—"}
              </div>
              <div className="mt-0.5 text-xs text-stone-500">of decided submissions</div>
            </div>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {(
              [
                ["By agency", scoreboard.byAgency],
                ["By NAICS", scoreboard.byNaics],
                ["By price band", scoreboard.byBand],
              ] as const
            ).map(([label, rows]) => (
              <div key={label} className="gs-card p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</div>
                {rows.length === 0 ? (
                  <p className="mt-2 text-xs text-stone-400">No submissions yet.</p>
                ) : (
                  <table className="mt-2 w-full text-xs">
                    <thead>
                      <tr className="text-left text-stone-400">
                        <th className="pb-1 font-normal">{label === "By price band" ? "Band" : label.slice(3)}</th>
                        <th className="pb-1 text-right font-normal">Sub</th>
                        <th className="pb-1 text-right font-normal">Won</th>
                        <th className="pb-1 text-right font-normal">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(label === "By price band"
                        ? [...rows].sort(
                            (a, b) =>
                              FP_PRICE_BANDS.findIndex((p) => p.key === a.key) -
                              FP_PRICE_BANDS.findIndex((p) => p.key === b.key),
                          )
                        : rows
                      ).map((r) => (
                        <tr key={r.key} className="border-t border-stone-100 text-stone-700">
                          <td className="max-w-40 truncate py-1 pr-2" title={r.key}>
                            {r.key}
                          </td>
                          <td className="py-1 text-right tabular-nums">{r.submitted}</td>
                          <td className="py-1 text-right tabular-nums">{r.won}</td>
                          <td className="py-1 text-right tabular-nums">
                            {r.decided > 0 ? `${Math.round((r.won / r.decided) * 100)}%` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* 4 — Waiting on response */}
        <section>
          <SectionTitle title="Waiting on response" hint="submitted, by time since submission" />
          {waiting.length === 0 ? (
            <p className="mt-2 text-sm text-stone-400">Nothing out for decision right now.</p>
          ) : (
            <div className="mt-2 flex flex-col gap-3">
              {waiting.map((bucket) => (
                <div key={bucket.label}>
                  <div className="text-xs font-medium uppercase tracking-wide text-stone-400">{bucket.label}</div>
                  <div className="mt-1 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {bucket.items.map(({ opp, days, contact }) => (
                      <div key={opp.id} className="gs-card flex items-start justify-between gap-3 p-3">
                        <div className="min-w-0">
                          <div className="line-clamp-2 text-[13px] font-medium text-stone-900" title={opp.title}>
                            {opp.title}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-stone-500">
                            {opp.agency ?? "—"}
                            {opp.priceQuoted != null && (
                              <span className="text-stone-400"> · {fmtUsd.format(opp.priceQuoted)}</span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-stone-500">
                            {contact ? (
                              <>
                                <span className="font-medium text-stone-600">{eventLabel(contact)}</span>{" "}
                                {daysAgo(contact.ts)}
                              </>
                            ) : (
                              <span className="text-stone-400">no CO contact since submission</span>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-lg font-semibold tabular-nums text-stone-800">{days}</div>
                          <div className="text-[11px] text-stone-400">days out</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 5 — Sources-sought radar */}
        <section>
          <SectionTitle title="Sources-sought radar" hint="watch-list items shaping future RFPs" />
          {radar.length === 0 ? (
            <p className="mt-2 text-sm text-stone-400">Radar is clear.</p>
          ) : (
            <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {radar.map((o) => {
                const h = hoursLeft(o.responseDeadline);
                return (
                  <div key={o.id} className="gs-card p-3">
                    <div className="line-clamp-2 text-[13px] font-medium text-stone-900" title={o.title}>
                      {o.title}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-stone-500">
                      {o.agency ?? "—"}
                      {o.solNumber ? <span className="text-stone-400"> · {o.solNumber}</span> : null}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-xs">
                      <span className={deadlineTone(h)}>
                        {o.responseDeadline ? fmtDeadlineStamp(o.responseDeadline) : "no deadline"}
                      </span>
                      {o.url ? (
                        <a
                          href={o.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-emerald-700 hover:underline"
                        >
                          notice ↗
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

      </div>

      {editing ? (
        <EditDialog
          opp={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteConfirmDialog
          opp={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            router.refresh();
          }}
        />
      ) : null}
      {chooser ? (
        <MoveChooserDialog
          opp={chooser.opp}
          groupLabel={chooser.groupLabel}
          statuses={dropStatusesFor(chooser.groupKey)}
          busy={moveBusy}
          error={moveError}
          onPick={(s) => void applyMove(chooser.opp, s)}
          onClose={() => {
            setChooser(null);
            setMoveError(null);
          }}
        />
      ) : null}
    </div>
  );
}
