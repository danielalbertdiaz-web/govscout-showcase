// Bid Board -> GovScout merge logic (pure functions only).
//
// Two fp_opportunities stores forked: ~/.openclaw/workspace/bid-board/data/
// pipeline.db kept receiving rows after GovScout's data/govscout.db became
// canonical. This module holds the side-effect-free pieces of the reconcile —
// epoch normalisation, raw-row mapping, field-level diffing, and upsert-input
// building. All database access lives in scripts/bidboard-merge.mts, so these
// functions stay testable without touching a database.
//
// Timestamp trap: Bid Board stored created_at/updated_at as TEXT (ISO 8601 —
// and, per the fork's history, sometimes epoch seconds), GovScout stores epoch
// MILLISECONDS. normaliseEpoch detects the unit per value; a blind multiply
// would corrupt values that are already milliseconds.

import {
  isFpStatus,
  isFpTier,
  isFpSource,
  type FpStatus,
  type FpTier,
  type FpSource,
  type FpOpportunity,
} from "./federal-pipeline-types";
import type { FpOpportunityInput } from "./federal-pipeline";

/** A row from either store, mapped to one comparable shape (timestamps in ms). */
export type MergeRow = {
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
  status: FpStatus;
  nobidReason: string | null;
  aiDeliverabilityScore: number | null;
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
  createdAt: number | null;
  updatedAt: number | null;
};

/**
 * Substantive fields compared during the merge. createdAt/updatedAt are
 * deliberately absent: after normaliseEpoch they are comparable, but a
 * difference there is bookkeeping (which fork touched the row last), not a
 * data conflict a human can adjudicate — so unit-only or genuine timestamp
 * drift never produces an enrichment or a conflict.
 */
export const COMPARED_FIELDS = [
  "solNumber",
  "noticeId",
  "trackingNumber",
  "title",
  "agency",
  "office",
  "naics",
  "setAside",
  "noticeType",
  "tier",
  "source",
  "url",
  "responseDeadline",
  "qaDeadline",
  "popStart",
  "popEnd",
  "submissionMethod",
  "submissionTarget",
  "status",
  "nobidReason",
  "aiDeliverabilityScore",
  "priceQuoted",
  "priceBasis",
  "competitorsEst",
  "poc1Name",
  "poc1Email",
  "poc1Phone",
  "poc2Name",
  "poc2Email",
  "poc2Phone",
  "draftPaths",
  "gmailDraftId",
  "gmailSentIds",
  "resultAwardAmount",
  "resultAwardee",
  "resultNotes",
] as const satisfies ReadonlyArray<keyof MergeRow>;

export type ComparedField = (typeof COMPARED_FIELDS)[number];

/**
 * Normalise an epoch-ish value to milliseconds, or null when unknown.
 *
 * Heuristic (per value, never blanket): >= 1e12 is already ms (2001+);
 * < 1e11 is seconds — multiply, but reject results before 2001 as junk
 * (so 0/small values map to null, never to 1970); the 1e11..1e12 band is
 * ambiguous (implausible as either unit) and maps to null. ISO-8601 strings
 * (what Bid Board actually stores) parse straight to ms.
 */
export function normaliseEpoch(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return normaliseEpochNumber(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return normaliseEpochNumber(Number(s));
    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function normaliseEpochNumber(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null; // 0/negative = unknown, not 1970
  if (n >= 1e12) return Math.round(n); // already milliseconds
  if (n >= 1e11) return null; // ambiguous band: too old for ms, absurd as seconds
  const ms = n * 1000; // seconds
  return ms >= 1e12 ? Math.round(ms) : null; // pre-2001 "seconds" = junk
}

/** Bid Board status if valid, otherwise the safe entry state. */
export function resolveStatus(raw: string | null | undefined): FpStatus {
  return raw && isFpStatus(raw) ? raw : "discovered";
}

function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "number") return Number.isNaN(v);
  return false;
}

function canon(v: unknown): unknown {
  if (isEmptyValue(v)) return null;
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return JSON.stringify(v);
  return v;
}

/** Equality across the stores' type drift (competitors_est: INTEGER vs TEXT). */
function fieldEquals(a: unknown, b: unknown): boolean {
  const ca = canon(a);
  const cb = canon(b);
  if (ca === cb) return true;
  if (ca == null || cb == null) return false;
  return String(ca) === String(cb);
}

export type FieldConflict = {
  solNumber: string | null;
  noticeId: string | null;
  field: ComparedField;
  govscout: unknown;
  bidboard: unknown;
};

export type RowDiff = {
  /** Fields where Bid Board has a value and GovScout is empty — safe to fill. */
  enrich: Partial<MergeRow>;
  /** Both sides non-empty and different — for the operator, never auto-resolved. */
  conflicts: FieldConflict[];
};

/**
 * Field-by-field comparison of one shared record. Rules, in order:
 * identical (post-normalisation) -> nothing; Bid Board empty -> nothing
 * (an empty value never overwrites GovScout); GovScout empty, Bid Board
 * set -> enrichment; both set and different -> conflict.
 */
export function diffRow(govscout: MergeRow, bidboard: MergeRow): RowDiff {
  const enrich: Partial<MergeRow> = {};
  const conflicts: FieldConflict[] = [];
  for (const field of COMPARED_FIELDS) {
    const g = govscout[field];
    const b = bidboard[field];
    if (fieldEquals(g, b)) continue;
    if (isEmptyValue(b)) continue;
    if (isEmptyValue(g)) {
      (enrich as Record<string, unknown>)[field] = b;
      continue;
    }
    conflicts.push({
      solNumber: govscout.solNumber ?? bidboard.solNumber,
      noticeId: govscout.noticeId ?? bidboard.noticeId,
      field,
      govscout: g,
      bidboard: b,
    });
  }
  return { enrich, conflicts };
}

/** A raw snake_case SELECT * row from the Bid Board fp_opportunities table. */
export type RawFpRow = Record<string, unknown>;

/** Map a raw Bid Board row into the comparable shape, normalising as we go. */
export function mapBidBoardRow(raw: RawFpRow): MergeRow {
  const str = (k: string): string | null => {
    const v = raw[k];
    if (v == null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  const num = (k: string): number | null => {
    const v = raw[k];
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const jsonArray = (k: string): string[] => {
    const v = raw[k];
    if (Array.isArray(v)) return v.map(String);
    if (typeof v !== "string" || !v.trim()) return [];
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  const tier = str("tier");
  const source = str("source");
  return {
    solNumber: str("sol_number"),
    noticeId: str("notice_id"),
    trackingNumber: str("tracking_number"),
    title: str("title") ?? "",
    agency: str("agency"),
    office: str("office"),
    naics: str("naics"),
    setAside: str("set_aside"),
    noticeType: str("notice_type"),
    tier: tier && isFpTier(tier) ? tier : null,
    source: source && isFpSource(source) ? source : "other",
    url: str("url"),
    responseDeadline: str("response_deadline"),
    qaDeadline: str("qa_deadline"),
    popStart: str("pop_start"),
    popEnd: str("pop_end"),
    submissionMethod: str("submission_method"),
    submissionTarget: str("submission_target"),
    status: resolveStatus(str("status")),
    nobidReason: str("nobid_reason"),
    aiDeliverabilityScore: num("ai_deliverability_score"),
    priceQuoted: num("price_quoted"),
    priceBasis: str("price_basis"),
    // INTEGER in Bid Board, TEXT in GovScout — unify as string.
    competitorsEst: str("competitors_est"),
    poc1Name: str("poc1_name"),
    poc1Email: str("poc1_email"),
    poc1Phone: str("poc1_phone"),
    poc2Name: str("poc2_name"),
    poc2Email: str("poc2_email"),
    poc2Phone: str("poc2_phone"),
    draftPaths: jsonArray("draft_paths"),
    gmailDraftId: str("gmail_draft_id"),
    gmailSentIds: jsonArray("gmail_sent_ids"),
    resultAwardAmount: num("result_award_amount"),
    resultAwardee: str("result_awardee"),
    resultNotes: str("result_notes"),
    createdAt: normaliseEpoch(raw["created_at"]),
    updatedAt: normaliseEpoch(raw["updated_at"]),
  };
}

/** Map a GovScout FpOpportunity (already camelCase) into the comparable shape. */
export function fromFpOpportunity(opp: FpOpportunity): MergeRow {
  return {
    solNumber: opp.solNumber,
    noticeId: opp.noticeId,
    trackingNumber: opp.trackingNumber,
    title: opp.title,
    agency: opp.agency,
    office: opp.office,
    naics: opp.naics,
    setAside: opp.setAside,
    noticeType: opp.noticeType,
    tier: opp.tier,
    source: opp.source,
    url: opp.url,
    responseDeadline: opp.responseDeadline,
    qaDeadline: opp.qaDeadline,
    popStart: opp.popStart,
    popEnd: opp.popEnd,
    submissionMethod: opp.submissionMethod,
    submissionTarget: opp.submissionTarget,
    status: opp.status,
    nobidReason: opp.nobidReason,
    aiDeliverabilityScore: opp.aiDeliverabilityScore,
    priceQuoted: opp.priceQuoted,
    priceBasis: opp.priceBasis,
    competitorsEst: opp.competitorsEst,
    poc1Name: opp.poc1Name,
    poc1Email: opp.poc1Email,
    poc1Phone: opp.poc1Phone,
    poc2Name: opp.poc2Name,
    poc2Email: opp.poc2Email,
    poc2Phone: opp.poc2Phone,
    draftPaths: opp.draftPaths,
    gmailDraftId: opp.gmailDraftId,
    gmailSentIds: opp.gmailSentIds,
    resultAwardAmount: opp.resultAwardAmount,
    resultAwardee: opp.resultAwardee,
    resultNotes: opp.resultNotes,
    createdAt: normaliseEpoch(opp.createdAt),
    updatedAt: normaliseEpoch(opp.updatedAt),
  };
}

/** Full upsert input for a Bid Board-only row (import path). */
export function buildImportInput(row: MergeRow): FpOpportunityInput {
  return {
    // The demo-fork Bid Board being merged back is Acme's own operating
    // history — 'el' by definition (migration 043).
    clientId: "el",
    solNumber: row.solNumber,
    noticeId: row.noticeId,
    trackingNumber: row.trackingNumber,
    title: row.title,
    agency: row.agency,
    office: row.office,
    naics: row.naics,
    setAside: row.setAside,
    noticeType: row.noticeType,
    tier: row.tier,
    source: row.source,
    url: row.url,
    responseDeadline: row.responseDeadline,
    qaDeadline: row.qaDeadline,
    popStart: row.popStart,
    popEnd: row.popEnd,
    submissionMethod: row.submissionMethod,
    submissionTarget: row.submissionTarget,
    status: row.status,
    nobidReason: row.nobidReason,
    aiDeliverabilityScore: row.aiDeliverabilityScore,
    priceQuoted: row.priceQuoted,
    priceBasis: row.priceBasis,
    competitorsEst: row.competitorsEst,
    poc1Name: row.poc1Name,
    poc1Email: row.poc1Email,
    poc1Phone: row.poc1Phone,
    poc2Name: row.poc2Name,
    poc2Email: row.poc2Email,
    poc2Phone: row.poc2Phone,
    draftPaths: row.draftPaths,
    gmailDraftId: row.gmailDraftId,
    gmailSentIds: row.gmailSentIds,
    resultAwardAmount: row.resultAwardAmount,
    resultAwardee: row.resultAwardee,
    resultNotes: row.resultNotes,
  };
}

/**
 * Partial upsert input for enrichment of a shared row: the GovScout row's own
 * natural keys (so the upsert lands on the matched row), its title (upsert
 * validation requires one; passing GovScout's own value is a no-op write), and
 * ONLY the enrichment fields. Conflicting fields are never included, so they
 * can never be overwritten. GovScout's status is never empty, so status is
 * never an enrichment — the reopen guard is never in play.
 */
export function buildEnrichmentInput(
  govscout: MergeRow,
  enrich: Partial<MergeRow>,
): FpOpportunityInput {
  const input: FpOpportunityInput = { clientId: "el", title: govscout.title };
  if (govscout.noticeId) input.noticeId = govscout.noticeId;
  if (govscout.solNumber) input.solNumber = govscout.solNumber;
  for (const [key, value] of Object.entries(enrich)) {
    if (key === "createdAt" || key === "updatedAt") continue; // upsert owns these
    (input as Record<string, unknown>)[key] = value;
  }
  return input;
}
