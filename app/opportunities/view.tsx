"use client";

// U-2: the unified opportunity view. Seven surfaces answered "what could I
// bid on?" from seven tables; this is the one place that answers it from all
// of them. Presentation is deliberately the Bid Board's status-column layout
// (the audit's strongest screen) — same card and column classes; /bid-board
// itself is untouched and each card links back to its owning page.

import { useMemo, useState } from "react";
import {
  PIPELINE_GROUPS,
  PIPELINE_SOURCES,
  filterPipeline,
  pipelineGroup,
  sortByDeadline,
  type PipelineItem,
  type PipelineSource,
} from "@/lib/pipeline-summary";
// Deadline vocabulary is shared with /bid-board (D-1) — one definition, so
// "past due" cannot drift between the two screens again. Re-exported so tests
// can pin this view's import path.
export { deadlineText } from "@/lib/deadline";
import { deadlineText, deadlineTone, hoursLeft } from "@/lib/deadline";
// Card/column markup is shared with /bid-board (cleanup task 3) — one
// definition, identity-pinned in tests/bid-board-view.test.ts.
export { PipelineCard, PipelineColumn } from "@/app/_components/PipelineBoard";
import { PipelineCard, PipelineColumn } from "@/app/_components/PipelineBoard";

type Props = {
  items: PipelineItem[];
};

const SOURCE_META: Record<PipelineSource, { chip: string; badge: string; badgeCls: string }> = {
  federal: { chip: "Federal", badge: "Bid Board", badgeCls: "border-emerald-300 bg-emerald-50 text-emerald-700" },
  micro: { chip: "Micro-purchase", badge: "Micro", badgeCls: "border-sky-300 bg-sky-50 text-sky-700" },
  saved: { chip: "Grants", badge: "Saved", badgeCls: "border-stone-300 bg-stone-50 text-stone-600" },
  teaming: { chip: "Teaming", badge: "Teaming", badgeCls: "border-amber-300 bg-amber-50 text-amber-800" },
  scout: { chip: "Scouts", badge: "Scout", badgeCls: "border-violet-300 bg-violet-50 text-violet-700" },
};

// Chip order per the audit: All / Federal / Micro-purchase / Grants / Teaming / Scouts.
const CHIP_ORDER: readonly PipelineSource[] = ["federal", "micro", "saved", "teaming", "scout"];

function statusLabel(status: string | null): string {
  return status ? status.replace(/_/g, " ") : "—";
}

function ItemCard({ item }: { item: PipelineItem }) {
  const h = hoursLeft(item.deadline);
  const meta = SOURCE_META[item.source];
  return (
    <PipelineCard
      title={item.title}
      subtitle={item.agency ?? "—"}
      deadlineLabel={deadlineText(item.deadline)}
      deadlineClass={deadlineTone(h)}
      badges={
        <span className="flex shrink-0 items-center gap-1">
          <span className={`rounded border px-1.5 py-0.5 text-[11px] ${meta.badgeCls}`}>{meta.badge}</span>
          <span className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-[11px] text-stone-500">
            {statusLabel(item.status)}
          </span>
        </span>
      }
      href={item.href}
    />
  );
}

export default function UnifiedOpportunitiesView({ items }: Props) {
  // Empty selection = all sources (the "All" chip).
  const [selected, setSelected] = useState<Set<PipelineSource>>(new Set());
  const [actionableOnly, setActionableOnly] = useState(true);
  // D-2: elapsed deadlines are excluded by default — an opportunity that
  // closed in June is not actionable in August whatever its status says —
  // but never silently: the count is shown and the exclusion is reversible.
  const [showPastDue, setShowPastDue] = useState(false);
  const [now] = useState(() => Date.now());

  // Chip counts reflect the actionable toggle and the past-due state so the
  // numbers match what the board below shows.
  const toggled = useMemo(
    () =>
      filterPipeline(
        items,
        showPastDue ? { actionableOnly } : { actionableOnly, excludePastDueAsOf: now },
      ),
    [items, actionableOnly, showPastDue, now],
  );
  const chipCounts = useMemo(() => {
    const counts = Object.fromEntries(PIPELINE_SOURCES.map((s) => [s, 0])) as Record<PipelineSource, number>;
    for (const i of toggled) counts[i.source] += 1;
    return counts;
  }, [toggled]);

  // Past-due count under the CURRENT source + actionable filters, so the
  // "N past due" button always says exactly how many rows it would reveal.
  const withPastDue = useMemo(
    () => filterPipeline(items, { sources: [...selected], actionableOnly }),
    [items, selected, actionableOnly],
  );
  const withoutPastDue = useMemo(
    () => filterPipeline(items, { sources: [...selected], actionableOnly, excludePastDueAsOf: now }),
    [items, selected, actionableOnly, now],
  );
  const pastDueCount = withPastDue.length - withoutPastDue.length;
  const visible = showPastDue ? withPastDue : withoutPastDue;

  const columns = useMemo(
    () =>
      PIPELINE_GROUPS.map((g) => ({
        ...g,
        rows: sortByDeadline(visible.filter((i) => pipelineGroup(i) === g.key)),
      })),
    [visible],
  );

  function toggleSource(s: PipelineSource) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  const chipBase = "rounded-full border px-2.5 py-1 text-xs font-semibold transition";
  const chipOn = "border-emerald-600 bg-emerald-600 text-white";
  const chipOff = "border-stone-300 bg-white text-stone-600 hover:border-stone-400";

  return (
    <div className="flex flex-col gap-4">
      {/* Source chips + actionable toggle */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-white p-3 shadow-sm">
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          className={`${chipBase} ${selected.size === 0 ? chipOn : chipOff}`}
        >
          All · {toggled.length}
        </button>
        {CHIP_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleSource(s)}
            className={`${chipBase} ${selected.has(s) ? chipOn : chipOff}`}
          >
            {SOURCE_META[s].chip} · {chipCounts[s]}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {(pastDueCount > 0 || showPastDue) && (
            <button
              type="button"
              onClick={() => setShowPastDue((v) => !v)}
              className="text-xs font-medium text-stone-500 underline decoration-dotted underline-offset-2 hover:text-stone-700"
            >
              {showPastDue
                ? `showing ${pastDueCount} past due — hide`
                : `${pastDueCount} past due hidden — show`}
            </button>
          )}
          <label className="flex items-center gap-1.5 text-xs text-stone-600">
            <input
              type="checkbox"
              checked={actionableOnly}
              onChange={(e) => setActionableOnly(e.target.checked)}
            />
            <span className="font-medium">Actionable only</span>
            <span className="hidden text-stone-400 sm:inline">
              — hides items already decided (no-bid, passed, dismissed)
            </span>
          </label>
        </div>
      </div>

      {/* Status-column board — the Bid Board's layout, spanning all sources */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {columns.map((col) => (
          <PipelineColumn key={col.key} label={col.label} count={col.rows.length}>
            {col.rows.map((item) => (
              <ItemCard key={`${item.source}-${item.id}`} item={item} />
            ))}
          </PipelineColumn>
        ))}
      </div>

      <p className="text-[11px] text-stone-400">
        One view over the Bid Board, micro-purchases, saved grants, teaming notices, and scout
        finds. Each card links to its owning page; the source pages are unchanged.
      </p>
    </div>
  );
}
