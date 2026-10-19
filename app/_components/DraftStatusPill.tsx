// Lifecycle pill for a draft's status. Server-safe (no client hooks) — shared
// by the home dashboard and the drafts list so the lifecycle reads the same
// everywhere.
//
// Colour carries meaning here, so the label always spells the state out: amber
// review states and red failure states must not be distinguishable by hue
// alone (V4.1 §21 — "meaningful status text rather than color alone").

import type { DraftStatus } from "@/lib/db";

const PILL: Record<DraftStatus, string> = {
  drafting: "border-sky-300 bg-sky-50 text-sky-800",
  auto_drafted: "border-violet-300 bg-violet-50 text-violet-800",
  needs_human_decision: "border-amber-400 bg-amber-50 text-amber-900",
  blocked_review_required: "border-orange-400 bg-orange-50 text-orange-900",
  failed_review_required: "border-red-400 bg-red-50 text-red-900",
  staged_for_review: "border-indigo-300 bg-indigo-50 text-indigo-800",
  submitted: "border-amber-300 bg-amber-50 text-amber-800",
  won: "border-emerald-300 bg-emerald-50 text-emerald-800",
  lost: "border-rose-300 bg-rose-50 text-rose-700",
  no_go: "border-stone-300 bg-stone-100 text-stone-700",
  duplicate: "border-stone-300 bg-stone-100 text-stone-600",
  cancelled: "border-stone-300 bg-stone-100 text-stone-600",
  expired: "border-stone-300 bg-stone-100 text-stone-600",
};

const LABEL: Record<DraftStatus, string> = {
  drafting: "drafting",
  auto_drafted: "auto-drafted",
  needs_human_decision: "needs decision",
  blocked_review_required: "blocked — review",
  failed_review_required: "failed — review",
  staged_for_review: "staged for review",
  submitted: "submitted",
  won: "won",
  lost: "lost",
  no_go: "no-go",
  duplicate: "duplicate",
  cancelled: "cancelled",
  expired: "expired",
};

export function DraftStatusPill({ status }: { status: DraftStatus }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PILL[status]}`}
    >
      {LABEL[status]}
    </span>
  );
}
