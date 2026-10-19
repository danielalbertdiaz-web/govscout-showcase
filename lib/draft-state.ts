// Application state machine (V4.1 §14.7).
//
// Before this, drafts.status accepted any of five values and any value could
// follow any other. A draft could go straight from "drafting" to "won" without
// ever having been submitted, and a terminal record could quietly reopen.
//
// This module is pure — no database, no I/O — so the transition rules are
// unit-tested directly. lib/db.ts consults it before writing.
//
// Design note on strictness: the machine is permissive where a human is
// legitimately recording something that happened outside GovScout (a person
// submitted a proposal and is now telling the system so), and strict where a
// state change would fabricate history (marking a draft "won" that was never
// submitted) or silently resurrect a closed record.

export const DRAFT_STATUSES = [
  // in flight
  "drafting",
  "auto_drafted",
  // review gates required by §14.7
  "needs_human_decision",
  "blocked_review_required",
  "failed_review_required",
  "staged_for_review",
  // human-performed
  "submitted",
  // terminal
  "won",
  "lost",
  "no_go",
  "duplicate",
  "cancelled",
  "expired",
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export function isDraftStatus(s: string): s is DraftStatus {
  return (DRAFT_STATUSES as readonly string[]).includes(s);
}

/** Nothing follows these without an explicit, reason-bearing reopen. */
export const TERMINAL_STATUSES: readonly DraftStatus[] = [
  "won",
  "lost",
  "no_go",
  "duplicate",
  "cancelled",
  "expired",
];

export function isTerminal(s: DraftStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** States that mean "a human must look at this before anything else happens". */
export const REVIEW_STATUSES: readonly DraftStatus[] = [
  "needs_human_decision",
  "blocked_review_required",
  "failed_review_required",
  "staged_for_review",
];

/** Any in-flight or review record can be closed out for these reasons. */
const CLOSE_OUT: DraftStatus[] = ["no_go", "duplicate", "cancelled", "expired"];

const TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  drafting: [
    "auto_drafted",
    "staged_for_review",
    "needs_human_decision",
    "blocked_review_required",
    "failed_review_required",
    // A human may record a submission they made themselves. GovScout never
    // submits; it records that a person did.
    "submitted",
    ...CLOSE_OUT,
  ],
  auto_drafted: [
    "drafting",
    "staged_for_review",
    "needs_human_decision",
    "blocked_review_required",
    "failed_review_required",
    "submitted",
    ...CLOSE_OUT,
  ],
  needs_human_decision: ["drafting", "auto_drafted", "staged_for_review", "submitted", ...CLOSE_OUT],
  blocked_review_required: ["drafting", "auto_drafted", "staged_for_review", ...CLOSE_OUT],
  failed_review_required: ["drafting", "auto_drafted", "staged_for_review", ...CLOSE_OUT],
  staged_for_review: [
    "drafting",
    "needs_human_decision",
    "blocked_review_required",
    "failed_review_required",
    "submitted",
    ...CLOSE_OUT,
  ],
  // Outcomes are only reachable from a submitted proposal. This is the rule
  // that stops a never-submitted draft being recorded as won.
  submitted: ["won", "lost", "cancelled", "expired"],
  won: [],
  lost: [],
  no_go: [],
  duplicate: [],
  cancelled: [],
  expired: [],
};

export function allowedTransitions(from: DraftStatus): readonly DraftStatus[] {
  return TRANSITIONS[from] ?? [];
}

export type TransitionResult = { ok: true } | { ok: false; reason: string };

/**
 * May `from` become `to`?
 *
 * `reopen` is the deliberate escape hatch for a terminal record — it exists so
 * that reopening is an explicit, auditable act rather than an accident.
 */
export function canTransition(
  from: DraftStatus,
  to: DraftStatus,
  opts: { reopen?: boolean } = {},
): TransitionResult {
  if (from === to) return { ok: true }; // idempotent re-set is not a transition

  if (isTerminal(from)) {
    if (!opts.reopen) {
      return {
        ok: false,
        reason: `"${from}" is terminal. Reopening requires an explicit reopen with a recorded reason.`,
      };
    }
    // A reopened record returns to work, never straight to another outcome.
    if (isTerminal(to)) {
      return { ok: false, reason: `Cannot move from terminal "${from}" directly to terminal "${to}".` };
    }
    return { ok: true };
  }

  const allowed = TRANSITIONS[from];
  if (!allowed) return { ok: false, reason: `Unknown status "${from}".` };
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `"${from}" cannot become "${to}". Allowed: ${allowed.join(", ")}.`,
    };
  }
  return { ok: true };
}

export function assertTransition(
  from: DraftStatus,
  to: DraftStatus,
  opts: { reopen?: boolean } = {},
): void {
  const result = canTransition(from, to, opts);
  if (!result.ok) throw new Error(`invalid status transition: ${result.reason}`);
}

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  drafting: "Drafting",
  auto_drafted: "Auto-drafted",
  needs_human_decision: "Needs your decision",
  blocked_review_required: "Blocked — review required",
  failed_review_required: "Failed — review required",
  staged_for_review: "Staged for review",
  submitted: "Submitted by human",
  won: "Won",
  lost: "Lost",
  no_go: "No-go",
  duplicate: "Duplicate",
  cancelled: "Cancelled",
  expired: "Expired",
};
