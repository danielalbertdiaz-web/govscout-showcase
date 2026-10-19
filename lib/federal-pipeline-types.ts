// Federal Pipeline (Bid Board) — types + constants only, safe for client
// bundles. DB access lives in ./federal-pipeline (same split as pools-types).

import type { FpScoreBasis, ScaleSignal } from "./scan-gates";

// Client-panel corpus scoping (PANEL_ISOLATION_SPEC.md §2, migration 043).
// The ONE canonical list — nothing anywhere hand-strings a client key. 'northstar'
// is reserved ahead of a signed engagement (spec §6.1) so the enum and the
// migration only ever change once; no northstar-scoped rows exist until then.
// Validation for writes lives in lib/client-scope.ts (requireClientId).
export const CLIENT_IDS = ["el", "riverside", "northstar"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export function isClientId(s: string): s is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(s);
}

// Panel display names. "Acme" not "Acme Consulting": the panel header sits next
// to client-neutral chrome and the short form is what the operator calls them.
export const CLIENT_LABELS: Record<ClientId, string> = {
  el: "Acme",
  riverside: "Riverside",
  northstar: "Northstar",
};

export const FP_STATUSES = [
  "discovered",
  "triaged_bid",
  "triaged_nobid",
  "triaged_watch",
  "drafting",
  "awaiting_approval",
  "submitted",
  "qa_open",
  "closed_won",
  "closed_lost",
  "closed_no_award",
  "withdrawn",
] as const;
export type FpStatus = (typeof FP_STATUSES)[number];

export function isFpStatus(s: string): s is FpStatus {
  return (FP_STATUSES as readonly string[]).includes(s);
}

export const FP_STATUS_LABELS: Record<FpStatus, string> = {
  discovered: "Discovered",
  triaged_bid: "Bid",
  triaged_nobid: "No-bid",
  triaged_watch: "Watch",
  drafting: "Drafting",
  awaiting_approval: "Awaiting approval",
  submitted: "Submitted",
  qa_open: "Q&A open",
  closed_won: "Won",
  closed_lost: "Lost",
  closed_no_award: "No award",
  withdrawn: "Withdrawn",
};

export const FP_EVENT_KINDS = [
  "discovered",
  "triaged",
  "draft_started",
  "draft_ready",
  "price_approved",
  "submitted",
  "revision_sent",
  "amendment_posted",
  "qa_asked",
  "qa_answered",
  "co_reply_received",
  "award_posted",
  "outcome_recorded",
  // Priority flag (migration 041) — a human "pay attention to this" call,
  // logged with who made it. Vocabulary is "Flagged" everywhere; there is no
  // second word for the same thing.
  "flagged",
  "unflagged",
  "note",
] as const;
export type FpEventKind = (typeof FP_EVENT_KINDS)[number];

export function isFpEventKind(k: string): k is FpEventKind {
  return (FP_EVENT_KINDS as readonly string[]).includes(k);
}

export const FP_TIERS = ["micro", "mid", "vehicle"] as const;
export type FpTier = (typeof FP_TIERS)[number];

export function isFpTier(t: string): t is FpTier {
  return (FP_TIERS as readonly string[]).includes(t);
}

export const FP_SOURCES = ["sam", "state", "county", "subnet", "other"] as const;
export type FpSource = (typeof FP_SOURCES)[number];

export function isFpSource(s: string): s is FpSource {
  return (FP_SOURCES as readonly string[]).includes(s);
}

// Kanban column grouping for the Bid Board pane.
export const FP_BOARD_GROUPS = [
  { key: "triage", label: "Triage", statuses: ["discovered", "triaged_bid", "triaged_watch"] },
  { key: "drafting", label: "Drafting", statuses: ["drafting"] },
  { key: "awaiting", label: "Awaiting the operator", statuses: ["awaiting_approval"] },
  { key: "submitted", label: "Submitted", statuses: ["submitted"] },
  { key: "qa", label: "Q&A", statuses: ["qa_open"] },
  {
    key: "closed",
    label: "Closed",
    statuses: ["triaged_nobid", "closed_won", "closed_lost", "closed_no_award", "withdrawn"],
  },
] as const satisfies ReadonlyArray<{ key: string; label: string; statuses: readonly FpStatus[] }>;

// Statuses that count as "open" (still in play) for the deadline strip.
export const FP_OPEN_STATUSES: readonly FpStatus[] = [
  "discovered",
  "triaged_bid",
  "triaged_watch",
  "drafting",
  "awaiting_approval",
  "submitted",
  "qa_open",
];

export type FpOpportunity = {
  id: string;
  /**
   * Which client's panel this row belongs to (migration 043). Identity, not an
   * editable field: set once at ingest, scoped through lib/client-scope.ts,
   * never updated by upsert or board edits. Panels/CLI filter on it; two
   * clients tracking the same federal notice are two separate rows.
   */
  clientId: ClientId;
  solNumber: string | null;
  noticeId: string | null;
  trackingNumber: string | null;
  title: string;
  agency: string | null;
  office: string | null;
  naics: string | null;
  setAside: string | null;
  noticeType: string | null;
  tier: FpTier | null;
  source: FpSource;
  url: string | null;
  responseDeadline: string | null;
  qaDeadline: string | null;
  popStart: string | null;
  popEnd: string | null;
  submissionMethod: string | null;
  submissionTarget: string | null;
  /**
   * Amount + eligibility/fit narrative as free text (migration 044). For
   * grants this carries what a procurement notice puts in structured fields
   * — "$1.1M CDC supplemental pool ...". Display-as-text on purpose; see the
   * migration header for why it is not a parsed numeric column.
   */
  description: string | null;
  status: FpStatus;
  nobidReason: string | null;
  aiDeliverabilityScore: number | null;
  /**
   * What aiDeliverabilityScore was computed FROM (migration 042, lib/scan-gates.ts)
   * — the price_basis pattern applied to the score. "notice_only" = unverified,
   * scored without opening the attached solicitation; it is the default and
   * covers every pre-042 score. Null exactly when the score is null.
   */
  scoreBasis: FpScoreBasis | null;
  /**
   * Enterprise-scale signals (migration 042): typed reasons the score was
   * capped and the row routed to a human. Downgrade-only — a signal never
   * removes a row. Distinct from flaggedAt, a human's own priority call.
   */
  scaleSignals: ScaleSignal[];
  priceQuoted: number | null;
  priceBasis: string | null;
  competitorsEst: string | null;
  poc1Name: string | null;
  poc1Email: string | null;
  poc1Phone: string | null;
  poc2Name: string | null;
  poc2Email: string | null;
  poc2Phone: string | null;
  draftPaths: string[];
  gmailDraftId: string | null;
  gmailSentIds: string[];
  resultAwardAmount: number | null;
  resultAwardee: string | null;
  resultNotes: string | null;
  /**
   * Priority flag (migration 041): when the operator marked this "pay attention to
   * this", or null = not flagged. Client-visible (the board badge reads it),
   * unlike archived_at. Written only via setFpFlag, never directly.
   */
  flaggedAt: number | null;
  /**
   * "Remind when reopens" (migration 046): set when a human marked this
   * passed-deadline grant as cyclical — watch for the next cycle. The row
   * leaves the go/no-go review queue while watched, and the discovery crons
   * re-search watched programs each run. Written only via setFpReopenWatch.
   */
  reopenWatchAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type FpEvent = {
  id: string;
  oppId: string;
  ts: number;
  kind: FpEventKind;
  detail: Record<string, unknown> | null;
};

// Price bands for the scoreboard hit-rate breakdown.
export const FP_PRICE_BANDS = [
  { key: "<25K", min: 0, max: 25_000 },
  { key: "25–75K", min: 25_000, max: 75_000 },
  { key: "75–250K", min: 75_000, max: 250_000 },
  { key: "250K+", min: 250_000, max: Infinity },
] as const;

export function fpPriceBand(amount: number | null): string | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  for (const b of FP_PRICE_BANDS) {
    if (amount >= b.min && amount < b.max) return b.key;
  }
  return null;
}
