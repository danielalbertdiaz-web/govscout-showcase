// Federal Pipeline (Bid Board) — SQLite state store for the federal
// micro-to-mid contract operation. Alfred (OpenClaw) drives writes through
// scripts/fp.mts; the /bid-board pane reads. Tables from 029_federal_pipeline.sql.

import { getDb } from "./db";
import { normalizeSolNumber } from "./opportunity-identity";
import { normaliseSetAside, isSetAsideCanonical, type SetAsideCanonical } from "./set-aside";
import {
  admitEligibility,
  detectScaleSignals,
  sanitiseScaleSignals,
  mergeScaleSignals,
  resolveScoreBasis,
  SCALE_SIGNAL_SCORE_CAP,
  type EligibilityExclusionReason,
  type FpScoreBasis,
  type ScaleSignal,
  type ScaleSignalKind,
} from "./scan-gates";
import { requireClientId } from "./client-scope";
import {
  isFpStatus,
  isFpTier,
  isFpSource,
  isFpEventKind,
  type ClientId,
  type FpStatus,
  type FpTier,
  type FpSource,
  type FpEventKind,
  type FpOpportunity,
  type FpEvent,
} from "./federal-pipeline-types";

export * from "./federal-pipeline-types";

type FpOppRow = {
  id: string;
  client_id: string;
  sol_number: string | null;
  notice_id: string | null;
  tracking_number: string | null;
  title: string;
  agency: string | null;
  office: string | null;
  naics: string | null;
  set_aside: string | null;
  set_aside_canonical: string | null;
  notice_type: string | null;
  tier: string | null;
  source: string;
  url: string | null;
  response_deadline: string | null;
  qa_deadline: string | null;
  pop_start: string | null;
  pop_end: string | null;
  submission_method: string | null;
  submission_target: string | null;
  description: string | null;
  status: string;
  nobid_reason: string | null;
  ai_deliverability_score: number | null;
  score_basis: string | null;
  scale_signals: string | null;
  price_quoted: number | null;
  price_basis: string | null;
  competitors_est: string | null;
  poc1_name: string | null;
  poc1_email: string | null;
  poc1_phone: string | null;
  poc2_name: string | null;
  poc2_email: string | null;
  poc2_phone: string | null;
  draft_paths: string | null;
  gmail_draft_id: string | null;
  gmail_sent_ids: string | null;
  result_award_amount: number | null;
  result_awardee: string | null;
  result_notes: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  flagged_at: number | null;
  reopen_watch_at: number | null;
};

/**
 * FpOpportunity plus the soft-delete marker from migration 034. Declared here
 * rather than in federal-pipeline-types.ts so the client-safe types module
 * stays untouched; structurally it is still assignable wherever a plain
 * FpOpportunity is expected.
 */
export type FpOpportunityRecord = FpOpportunity & {
  archivedAt: number | null;
  /** Controlled set-aside vocabulary (migration 039, lib/set-aside.ts). */
  setAsideCanonical: SetAsideCanonical | null;
};

type FpEventRow = {
  id: string;
  opp_id: string;
  ts: number;
  kind: string;
  detail: string | null;
};

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function rowToOpp(row: FpOppRow): FpOpportunityRecord {
  return {
    id: row.id,
    // requireClientId, not a fallback: a row whose client_id is outside the
    // canonical list must fail loudly, never silently read as Acme's (the
    // "unknown never means healthy" rule, COI edition).
    clientId: requireClientId(row.client_id),
    solNumber: row.sol_number,
    noticeId: row.notice_id,
    trackingNumber: row.tracking_number,
    title: row.title,
    agency: row.agency,
    office: row.office,
    naics: row.naics,
    setAside: row.set_aside,
    setAsideCanonical: isSetAsideCanonical(row.set_aside_canonical) ? row.set_aside_canonical : null,
    noticeType: row.notice_type,
    tier: row.tier && isFpTier(row.tier) ? row.tier : null,
    source: isFpSource(row.source) ? row.source : "other",
    url: row.url,
    responseDeadline: row.response_deadline,
    qaDeadline: row.qa_deadline,
    popStart: row.pop_start,
    popEnd: row.pop_end,
    submissionMethod: row.submission_method,
    submissionTarget: row.submission_target,
    description: row.description,
    status: isFpStatus(row.status) ? row.status : "discovered",
    nobidReason: row.nobid_reason,
    aiDeliverabilityScore: row.ai_deliverability_score == null ? null : Number(row.ai_deliverability_score),
    // A score whose basis is anything but an exact "attachment_reviewed" —
    // including NULL on every pre-042 row — reads as notice_only: unverifiable
    // must never read as verified, and legacy scores need no backfill.
    scoreBasis: row.ai_deliverability_score == null ? null : resolveScoreBasis(row.score_basis),
    scaleSignals: sanitiseScaleSignals(row.scale_signals ? safeParse<unknown>(row.scale_signals, []) : []),
    priceQuoted: row.price_quoted == null ? null : Number(row.price_quoted),
    priceBasis: row.price_basis,
    competitorsEst: row.competitors_est,
    poc1Name: row.poc1_name,
    poc1Email: row.poc1_email,
    poc1Phone: row.poc1_phone,
    poc2Name: row.poc2_name,
    poc2Email: row.poc2_email,
    poc2Phone: row.poc2_phone,
    draftPaths: row.draft_paths ? safeParse<string[]>(row.draft_paths, []) : [],
    gmailDraftId: row.gmail_draft_id,
    gmailSentIds: row.gmail_sent_ids ? safeParse<string[]>(row.gmail_sent_ids, []) : [],
    resultAwardAmount: row.result_award_amount == null ? null : Number(row.result_award_amount),
    resultAwardee: row.result_awardee,
    resultNotes: row.result_notes,
    flaggedAt: row.flagged_at == null ? null : Number(row.flagged_at),
    reopenWatchAt: row.reopen_watch_at == null ? null : Number(row.reopen_watch_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
  };
}

function rowToEvent(row: FpEventRow): FpEvent {
  return {
    id: row.id,
    oppId: row.opp_id,
    ts: Number(row.ts),
    kind: isFpEventKind(row.kind) ? row.kind : "note",
    detail: row.detail ? safeParse<Record<string, unknown>>(row.detail, {}) : null,
  };
}

export type FpOpportunityInput = {
  /**
   * REQUIRED — which client's panel this row belongs to (migration 043,
   * PANEL_ISOLATION_SPEC.md). Deliberately not optional and never defaulted:
   * a caller that doesn't know its client is exactly the bug the chokepoint
   * exists to catch. Dedupe is scoped by it — two clients tracking the same
   * notice are two rows — and it is immutable after create.
   */
  clientId: ClientId;
  // Set true to allow ingest to move status away from a non-"discovered"
  // value (see the reopen guard in upsertFpOpportunity). Default false.
  forceReopen?: boolean;
  solNumber?: string | null;
  noticeId?: string | null;
  trackingNumber?: string | null;
  title: string;
  agency?: string | null;
  office?: string | null;
  naics?: string | null;
  setAside?: string | null;
  noticeType?: string | null;
  tier?: FpTier | null;
  source?: FpSource;
  url?: string | null;
  responseDeadline?: string | null;
  qaDeadline?: string | null;
  popStart?: string | null;
  popEnd?: string | null;
  submissionMethod?: string | null;
  submissionTarget?: string | null;
  status?: FpStatus;
  nobidReason?: string | null;
  aiDeliverabilityScore?: number | null;
  /**
   * Basis claim for an incoming score (migration 042). ONLY the exact string
   * "attachment_reviewed" marks the score verified; anything else — absent,
   * null, free text — is stored as "notice_only". Never inherited across a
   * fresh score write: each score needs its own positive assertion.
   */
  scoreBasis?: string | null;
  /**
   * Scanner-reported enterprise-scale signals (kinds from lib/scan-gates.ts;
   * unknown kinds are dropped). Merged with signals detected from title/
   * description AND with signals already stored — sticky, so a text-less
   * re-ingest can never launder a capped score back above the cap. Pass an
   * explicit null to clear (a deliberate act, e.g. a human ruling the scale
   * concern wrong).
   */
  scaleSignals?: unknown;
  /**
   * Notice/grant text: the amount and eligibility/fit narrative as free text.
   * Stored since migration 044 (it was gate-detection-only before, which
   * silently discarded every dollar amount the Riverside cron found) AND still
   * feeds scale-signal/eligibility gate detection in gateScoreWrite.
   */
  description?: string | null;
  priceQuoted?: number | null;
  priceBasis?: string | null;
  competitorsEst?: string | null;
  poc1Name?: string | null;
  poc1Email?: string | null;
  poc1Phone?: string | null;
  poc2Name?: string | null;
  poc2Email?: string | null;
  poc2Phone?: string | null;
  draftPaths?: string[];
  gmailDraftId?: string | null;
  gmailSentIds?: string[];
  resultAwardAmount?: number | null;
  resultAwardee?: string | null;
  resultNotes?: string | null;
};

/**
 * Resolve an opportunity by CLI handle: exact id, then notice_id, then
 * sol_number. Returns null when nothing matches (ambiguity is impossible —
 * notice_id is unique-indexed; if a sol_number matches several rows we take
 * the most recently updated, which is the row a human means).
 *
 * `clientId` (migration 043) scopes every branch when given — including the
 * exact-id one, so a CLI invocation under the wrong --client answers "no
 * match" rather than reaching into another panel's row. Notice_id/sol_number
 * are only unique per client now (two clients may track the same notice).
 * Callers that hold an exact row id (the board API) may omit it.
 */
export function findFpOpportunity(handle: string, clientId?: ClientId): FpOpportunityRecord | null {
  const db = getDb();
  const scope = clientId ? " AND client_id = @client" : "";
  const params = clientId ? { handle, client: clientId } : { handle };
  const byId = db
    .prepare(`SELECT * FROM fp_opportunities WHERE id = @handle${scope}`)
    .get(params) as FpOppRow | undefined;
  if (byId) return rowToOpp(byId);
  const byNotice = db
    .prepare(`SELECT * FROM fp_opportunities WHERE notice_id = @handle${scope}`)
    .get(params) as FpOppRow | undefined;
  if (byNotice) return rowToOpp(byNotice);
  const bySol = db
    .prepare(`SELECT * FROM fp_opportunities WHERE sol_number = @handle${scope} ORDER BY updated_at DESC LIMIT 1`)
    .get(params) as FpOppRow | undefined;
  if (bySol) return rowToOpp(bySol);
  // Last resort: sol numbers arrive formatted inconsistently across SAM
  // exports and human notes (HT0038-26-SC-004 vs HT003826SC004, case drift).
  // Compare with punctuation stripped so either form resolves.
  const norm = normalizeSol(handle);
  if (!norm) return null;
  const loose = db
    .prepare(
      `SELECT * FROM fp_opportunities WHERE sol_number IS NOT NULL${clientId ? " AND client_id = @client" : ""} ORDER BY updated_at DESC`,
    )
    .all(clientId ? { client: clientId } : {}) as FpOppRow[];
  const hit = loose.find((r) => normalizeSol(r.sol_number ?? "") === norm);
  return hit ? rowToOpp(hit) : null;
}

// Sol-number normalisation lives in lib/opportunity-identity.ts (R-1) — one
// definition shared with the staging-to-canonical linker; do not copy it back.
const normalizeSol = normalizeSolNumber;

// ai_deliverability_score is deliberately absent: it is written only through
// the score gate (gateScoreWrite), never as a plain pass-through column.
const OPP_COLUMNS: Array<[keyof FpOpportunityInput, string]> = [
  ["solNumber", "sol_number"],
  ["noticeId", "notice_id"],
  ["trackingNumber", "tracking_number"],
  ["title", "title"],
  ["agency", "agency"],
  ["office", "office"],
  ["naics", "naics"],
  ["setAside", "set_aside"],
  ["noticeType", "notice_type"],
  ["tier", "tier"],
  ["source", "source"],
  ["url", "url"],
  ["responseDeadline", "response_deadline"],
  ["qaDeadline", "qa_deadline"],
  ["popStart", "pop_start"],
  ["popEnd", "pop_end"],
  ["submissionMethod", "submission_method"],
  ["submissionTarget", "submission_target"],
  ["description", "description"],
  ["status", "status"],
  ["nobidReason", "nobid_reason"],
  ["priceQuoted", "price_quoted"],
  ["priceBasis", "price_basis"],
  ["competitorsEst", "competitors_est"],
  ["poc1Name", "poc1_name"],
  ["poc1Email", "poc1_email"],
  ["poc1Phone", "poc1_phone"],
  ["poc2Name", "poc2_name"],
  ["poc2Email", "poc2_email"],
  ["poc2Phone", "poc2_phone"],
  ["gmailDraftId", "gmail_draft_id"],
  ["resultAwardAmount", "result_award_amount"],
  ["resultAwardee", "result_awardee"],
  ["resultNotes", "result_notes"],
];

/** Tier 1: a positively identified disqualifier withheld the score. */
export type FpScoreWithheld = {
  reason: EligibilityExclusionReason;
  evidence: string;
  /** The score that was NOT written (incoming, or the stored one being nulled). */
  withheldScore: number;
};

/** Tier 2: scale signals discounted the score. The row always stays visible. */
export type FpScoreCapped = {
  rawScore: number;
  cappedTo: number;
  signals: ScaleSignalKind[];
};

type ScoreGateResult = {
  /** Column writes; a key left undefined means "leave the column untouched". */
  score?: number | null;
  scoreBasis?: FpScoreBasis | null;
  scaleSignalsJson?: string | null;
  scoreWithheld?: FpScoreWithheld;
  scoreCapped?: FpScoreCapped;
};

/**
 * The scanner scoring gate (SCANNER_SCORING_DEFECT_PACKET, lib/scan-gates.ts)
 * — the only path by which ai_deliverability_score, score_basis and
 * scale_signals are ever written. Order is load-bearing and tested:
 *
 *   1. Tier 1 eligibility runs FIRST and short-circuits: a positive
 *      sole-source/brand-name or reseller-only match means no deliverability
 *      number is computed, capped, or stored at all — canon never holds a
 *      confident verdict on a notice Acme cannot bid. The ROW is still written:
 *      withholding a number is not a kill (the foreign-PoP lesson).
 *   2. Tier 2 scale signals then cap an over-cap score and travel with the
 *      row as named reasons. Signals are STICKY: stored ∪ detected ∪
 *      reported, so a text-less re-ingest can never launder a capped score
 *      back above the cap. Only an explicit scaleSignals: null clears them.
 *   3. The attachment gate: every stored score carries a basis, and only an
 *      exact "attachment_reviewed" claim stores as verified — absent or
 *      unrecognised claims store as "notice_only". Unverifiable must never
 *      read as verified.
 */
function gateScoreWrite(
  input: FpOpportunityInput,
  existing: { score: number | null; signals: ScaleSignal[] },
): ScoreGateResult {
  const scoreIn = input.aiDeliverabilityScore;
  const textProvided = input.description !== undefined;
  const gateText = [input.title ?? "", input.description ?? ""].join("\n");
  const out: ScoreGateResult = {};

  // Tier 1 — before anything score-shaped happens. Positive match only; an
  // unclassifiable notice is admitted (admitEligibility mirrors admitSetAside).
  const scoreAtStake =
    typeof scoreIn === "number" ? scoreIn : textProvided && existing.score != null ? existing.score : null;
  if (scoreAtStake != null) {
    const elig = admitEligibility(gateText);
    if (!elig.admitted) {
      out.score = null;
      out.scoreBasis = null;
      out.scoreWithheld = { reason: elig.reason, evidence: elig.evidence, withheldScore: scoreAtStake };
      return out;
    }
  }

  // Tier 2 — sticky union, recomputed whenever a score arrives, signals are
  // reported, or notice text is provided; untouched otherwise.
  let signals: ScaleSignal[] | undefined;
  if (scoreIn !== undefined || input.scaleSignals !== undefined || textProvided) {
    const kept = input.scaleSignals === null ? [] : mergeScaleSignals(existing.signals, sanitiseScaleSignals(input.scaleSignals));
    signals = mergeScaleSignals(kept, typeof scoreIn === "number" || textProvided ? detectScaleSignals(gateText) : []);
    out.scaleSignalsJson = signals.length ? JSON.stringify(signals) : null;
  }

  if (scoreIn === null) {
    // Explicit clear: no score, so no basis either.
    out.score = null;
    out.scoreBasis = null;
    return out;
  }

  if (typeof scoreIn === "number") {
    let final = scoreIn;
    if (signals && signals.length > 0 && final > SCALE_SIGNAL_SCORE_CAP) {
      out.scoreCapped = { rawScore: scoreIn, cappedTo: SCALE_SIGNAL_SCORE_CAP, signals: signals.map((s) => s.kind) };
      final = SCALE_SIGNAL_SCORE_CAP;
    }
    out.score = final;
    // Never inherited: a fresh score needs its own positive basis assertion.
    out.scoreBasis = resolveScoreBasis(input.scoreBasis);
    return out;
  }

  // No incoming score — but newly landed signals must still discount an
  // existing over-cap score (the NHTSA flow: the 4,173-hours table lives in
  // the 81-page RFP, so the signal arrives AFTER the notice-only 80/100).
  if (signals && signals.length > 0 && existing.score != null && existing.score > SCALE_SIGNAL_SCORE_CAP) {
    out.scoreCapped = { rawScore: existing.score, cappedTo: SCALE_SIGNAL_SCORE_CAP, signals: signals.map((s) => s.kind) };
    out.score = SCALE_SIGNAL_SCORE_CAP;
  }
  // Basis-only update ("read the RFP, score stands — mark it verified").
  if (input.scoreBasis !== undefined && (existing.score != null || out.score != null)) {
    out.scoreBasis = resolveScoreBasis(input.scoreBasis);
  }
  return out;
}

/** Gate outcomes land on the event trail (kind "note", like edit trails). */
function logScoreGateEvent(
  oppId: string,
  action: "score_withheld" | "score_capped",
  detail: FpScoreWithheld | FpScoreCapped,
): void {
  logFpEvent(oppId, "note", { via: "score gate", action, ...detail });
}

/**
 * Upsert by natural key: notice_id first, then sol_number. On update only the
 * fields present in `input` are written — absent fields keep their stored
 * values, so a re-ingest from a scan never clobbers operator-entered pricing
 * or POCs (same preserve-on-upsert discipline as upsertDiscoveredPool).
 */
export function upsertFpOpportunity(
  input: FpOpportunityInput,
): {
  opp: FpOpportunity;
  created: boolean;
  statusChangeBlocked?: { from: FpStatus; attempted: FpStatus };
  /**
   * Set when the record matches a permanent-delete tombstone (migration 036).
   * NOTHING was written: `opp` is a stand-in built from the tombstone and
   * `created` is false. Importers should count and report these as skipped.
   */
  skippedDeleted?: FpTombstone;
  /** Tier 1 (migration 042): a disqualifier kept the score out of canon. */
  scoreWithheld?: FpScoreWithheld;
  /** Tier 2 (migration 042): scale signals discounted the score. */
  scoreCapped?: FpScoreCapped;
} {
  // The chokepoint (lib/client-scope.ts): throws on a missing/unknown client.
  // Validated FIRST — a row must never be written, or even matched, without
  // knowing whose panel it belongs to.
  const clientId = requireClientId(input.clientId);
  if (!input.title || !input.title.trim()) throw new Error("title is required");
  if (input.status && !isFpStatus(input.status)) throw new Error(`invalid status: ${input.status}`);
  if (input.tier != null && !isFpTier(input.tier)) throw new Error(`invalid tier: ${input.tier}`);
  if (input.source && !isFpSource(input.source)) throw new Error(`invalid source: ${input.source}`);

  // Tombstone guard: a permanently deleted opportunity must never be
  // recreated by ingest — that is the entire point of the tombstone.
  // Tombstones are GLOBAL (no client_id, migration 043 note): every existing
  // one is an Acme-era judgement, and until they are scoped, a notice Acme
  // deleted stays out for every client.
  const tombstone = findFpTombstone(input.noticeId ?? null, input.solNumber ?? null);
  if (tombstone) {
    return { opp: tombstoneStandIn(tombstone, clientId), created: false, skippedDeleted: tombstone };
  }

  // Dedupe is scoped to (client_id, natural key) — unscoped, an Riverside ingest
  // of a notice already on Acme's board would silently UPDATE Acme's row, which
  // is cross-client contamination, not deduplication. Two clients tracking
  // the same federal notice are two independent rows.
  const db = getDb();
  let existing: FpOppRow | undefined;
  if (input.noticeId) {
    existing = db
      .prepare("SELECT * FROM fp_opportunities WHERE notice_id = ? AND client_id = ?")
      .get(input.noticeId, clientId) as FpOppRow | undefined;
  }
  if (!existing && input.solNumber) {
    existing = db
      .prepare("SELECT * FROM fp_opportunities WHERE sol_number = ? AND client_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(input.solNumber, clientId) as FpOppRow | undefined;
  }

  const now = Date.now();
  if (!existing) {
    const gate = gateScoreWrite(input, { score: null, signals: [] });
    const id = randomId();
    db.prepare(`
      INSERT INTO fp_opportunities (
        id, client_id, sol_number, notice_id, tracking_number, title, agency, office, naics,
        set_aside, set_aside_canonical, notice_type, tier, source, url, response_deadline, qa_deadline,
        pop_start, pop_end, submission_method, submission_target, description, status,
        nobid_reason, ai_deliverability_score, score_basis, scale_signals, price_quoted, price_basis,
        competitors_est, poc1_name, poc1_email, poc1_phone, poc2_name, poc2_email,
        poc2_phone, draft_paths, gmail_draft_id, gmail_sent_ids,
        result_award_amount, result_awardee, result_notes, created_at, updated_at
      ) VALUES (
        @id, @client_id, @sol_number, @notice_id, @tracking_number, @title, @agency, @office, @naics,
        @set_aside, @set_aside_canonical, @notice_type, @tier, @source, @url, @response_deadline, @qa_deadline,
        @pop_start, @pop_end, @submission_method, @submission_target, @description, @status,
        @nobid_reason, @ai_deliverability_score, @score_basis, @scale_signals, @price_quoted, @price_basis,
        @competitors_est, @poc1_name, @poc1_email, @poc1_phone, @poc2_name, @poc2_email,
        @poc2_phone, @draft_paths, @gmail_draft_id, @gmail_sent_ids,
        @result_award_amount, @result_awardee, @result_notes, @created_at, @updated_at
      )
    `).run({
      id,
      client_id: clientId,
      sol_number: input.solNumber ?? null,
      notice_id: input.noticeId ?? null,
      tracking_number: input.trackingNumber ?? null,
      title: input.title.trim(),
      agency: input.agency ?? null,
      office: input.office ?? null,
      naics: input.naics ?? null,
      set_aside: input.setAside ?? null,
      set_aside_canonical: normaliseSetAside(input.setAside ?? null).canonical,
      notice_type: input.noticeType ?? null,
      tier: input.tier ?? null,
      source: input.source ?? "sam",
      url: input.url ?? null,
      response_deadline: input.responseDeadline ?? null,
      qa_deadline: input.qaDeadline ?? null,
      pop_start: input.popStart ?? null,
      pop_end: input.popEnd ?? null,
      submission_method: input.submissionMethod ?? null,
      submission_target: input.submissionTarget ?? null,
      description: input.description ?? null,
      status: input.status ?? "discovered",
      nobid_reason: input.nobidReason ?? null,
      ai_deliverability_score: gate.score ?? null,
      score_basis: gate.scoreBasis ?? null,
      scale_signals: gate.scaleSignalsJson ?? null,
      price_quoted: input.priceQuoted ?? null,
      price_basis: input.priceBasis ?? null,
      competitors_est: input.competitorsEst ?? null,
      poc1_name: input.poc1Name ?? null,
      poc1_email: input.poc1Email ?? null,
      poc1_phone: input.poc1Phone ?? null,
      poc2_name: input.poc2Name ?? null,
      poc2_email: input.poc2Email ?? null,
      poc2_phone: input.poc2Phone ?? null,
      draft_paths: JSON.stringify(input.draftPaths ?? []),
      gmail_draft_id: input.gmailDraftId ?? null,
      gmail_sent_ids: JSON.stringify(input.gmailSentIds ?? []),
      result_award_amount: input.resultAwardAmount ?? null,
      result_awardee: input.resultAwardee ?? null,
      result_notes: input.resultNotes ?? null,
      created_at: now,
      updated_at: now,
    });
    // Gate outcomes land on the event trail so `fp show` explains a missing
    // or discounted score long after this call's stdout is gone.
    if (gate.scoreWithheld) logScoreGateEvent(id, "score_withheld", gate.scoreWithheld);
    if (gate.scoreCapped) logScoreGateEvent(id, "score_capped", gate.scoreCapped);
    // A row born past "discovered" (e.g. an ingest payload carrying
    // status: "triaged_nobid") is a status decision and must land on the
    // trail like any other — this was the source of the 34-decisions-vs-9-
    // events gap: the CLI logs "discovered" on create, and nothing recorded
    // the triage half.
    const bornStatus = input.status ?? "discovered";
    if (bornStatus !== "discovered") {
      logFpEvent(id, STATUS_EVENT_KIND[bornStatus] ?? "note", {
        via: "ingest",
        from: null,
        to: bornStatus,
      });
    }
    const row = db.prepare("SELECT * FROM fp_opportunities WHERE id = ?").get(id) as FpOppRow;
    return { opp: rowToOpp(row), created: true, scoreWithheld: gate.scoreWithheld, scoreCapped: gate.scoreCapped };
  }

  // Reopen guard (added 2026-07-31 after the NIST tech-transfer opp was
  // silently flipped triaged_nobid -> triaged_bid by a plain re-ingest on
  // 7/27, and the identical failure hit NIH GLP-1 the same week). A bare
  // ingest is meant to enrich/refresh fields from a scan, not to make
  // deliberate triage decisions -- those belong to `fp set-status`. So once
  // an opportunity has moved past "discovered", ingest must not silently
  // change its status (or clear its nobid_reason) unless forceReopen=true.
  let statusChangeBlocked: { from: FpStatus; attempted: FpStatus } | undefined;
  const existingStatus = existing.status as FpStatus;
  const reopenGuarded = existingStatus !== "discovered" && !input.forceReopen;
  if (reopenGuarded && input.status !== undefined && input.status !== existingStatus) {
    statusChangeBlocked = { from: existingStatus, attempted: input.status };
  }

  const fields: string[] = [];
  const params: Record<string, unknown> = { id: existing.id };
  for (const [key, col] of OPP_COLUMNS) {
    if (input[key] === undefined) continue;
    if (reopenGuarded && (key === "status" || key === "nobidReason")) continue;
    fields.push(`${col} = @${col}`);
    params[col] = input[key] ?? null;
  }
  const existingScore = existing.ai_deliverability_score == null ? null : Number(existing.ai_deliverability_score);
  const gate = gateScoreWrite(input, {
    score: existingScore,
    signals: sanitiseScaleSignals(existing.scale_signals ? safeParse<unknown>(existing.scale_signals, []) : []),
  });
  if (gate.score !== undefined) {
    fields.push("ai_deliverability_score = @ai_deliverability_score");
    params.ai_deliverability_score = gate.score;
  }
  if (gate.scoreBasis !== undefined) {
    fields.push("score_basis = @score_basis");
    params.score_basis = gate.scoreBasis;
  }
  if (gate.scaleSignalsJson !== undefined) {
    fields.push("scale_signals = @scale_signals");
    params.scale_signals = gate.scaleSignalsJson;
  }
  if (input.setAside !== undefined) {
    // The canonical column shadows the raw one wherever the raw one is
    // written (migration 039); the raw string itself is stored untouched.
    fields.push("set_aside_canonical = @set_aside_canonical");
    params.set_aside_canonical = normaliseSetAside(input.setAside ?? null).canonical;
  }
  if (input.draftPaths !== undefined) {
    fields.push("draft_paths = @draft_paths");
    params.draft_paths = JSON.stringify(input.draftPaths ?? []);
  }
  if (input.gmailSentIds !== undefined) {
    fields.push("gmail_sent_ids = @gmail_sent_ids");
    params.gmail_sent_ids = JSON.stringify(input.gmailSentIds ?? []);
  }
  if (fields.length > 0) {
    fields.push("updated_at = @updated_at");
    params.updated_at = now;
    db.prepare(`UPDATE fp_opportunities SET ${fields.join(", ")} WHERE id = @id`).run(params);
  }
  // Trail events only when the stored score actually moved — a scanner
  // re-sending the same over-cap number every day must not spam fp_events.
  if (gate.scoreWithheld && existingScore != null) {
    logScoreGateEvent(existing.id, "score_withheld", gate.scoreWithheld);
  }
  if (gate.scoreCapped && gate.score !== undefined && existingScore !== gate.score) {
    logScoreGateEvent(existing.id, "score_capped", gate.scoreCapped);
  }
  // Same discipline on update: when an ingest actually moved the status
  // (only possible on a still-"discovered" row, or under forceReopen), the
  // transition gets its matching trail event here — at the write, not at the
  // caller's discretion. Callers forgetting the event half is the class of
  // bug this eliminates.
  if (input.status !== undefined && !reopenGuarded && input.status !== existingStatus) {
    logFpEvent(existing.id, STATUS_EVENT_KIND[input.status] ?? "note", {
      via: "ingest",
      from: existingStatus,
      to: input.status,
      ...(input.forceReopen ? { forceReopen: true } : {}),
    });
  }
  const row = db.prepare("SELECT * FROM fp_opportunities WHERE id = ?").get(existing.id) as FpOppRow;
  return {
    opp: rowToOpp(row),
    created: false,
    statusChangeBlocked,
    scoreWithheld: gate.scoreWithheld,
    scoreCapped: gate.scoreCapped,
  };
}

export function logFpEvent(
  oppId: string,
  kind: FpEventKind,
  detail?: Record<string, unknown> | null,
): FpEvent {
  if (!isFpEventKind(kind)) throw new Error(`invalid event kind: ${kind}`);
  const db = getDb();
  const owns = db.prepare("SELECT 1 FROM fp_opportunities WHERE id = ?").get(oppId);
  if (!owns) throw new Error(`unknown opportunity id: ${oppId}`);
  const id = randomId();
  const ts = Date.now();
  db.prepare("INSERT INTO fp_events (id, opp_id, ts, kind, detail) VALUES (?, ?, ?, ?, ?)").run(
    id,
    oppId,
    ts,
    kind,
    detail ? JSON.stringify(detail) : null,
  );
  const row = db.prepare("SELECT * FROM fp_events WHERE id = ?").get(id) as FpEventRow;
  return rowToEvent(row);
}

// Which audit-trail kind a status transition implies (spec: set-status "logs
// matching event"). Transitions without a first-class kind fall back to note.
const STATUS_EVENT_KIND: Partial<Record<FpStatus, FpEventKind>> = {
  discovered: "discovered",
  triaged_bid: "triaged",
  triaged_nobid: "triaged",
  triaged_watch: "triaged",
  drafting: "draft_started",
  awaiting_approval: "draft_ready",
  submitted: "submitted",
  qa_open: "qa_asked",
  closed_won: "outcome_recorded",
  closed_lost: "outcome_recorded",
  closed_no_award: "outcome_recorded",
};

export function setFpStatus(
  handle: string,
  status: FpStatus,
  note?: string | null,
  clientId?: ClientId,
): { opp: FpOpportunity; event: FpEvent } {
  if (!isFpStatus(status)) throw new Error(`invalid status: ${status}`);
  const opp = findFpOpportunity(handle, clientId);
  if (!opp) throw new Error(`no opportunity matches: ${handle}`);
  const db = getDb();
  // One transaction: the status write and its trail event live or die
  // together. A crash between the two is how a "submitted" row ends up with
  // no submitted event — the gap class the 2026-08-13 audit measured.
  // AnyDb does not expose .transaction() (see lib/scouts.ts) — raw BEGIN
  // IMMEDIATE, like deleteFpOpportunity.
  db.exec("BEGIN IMMEDIATE");
  let event: FpEvent;
  try {
    db.prepare("UPDATE fp_opportunities SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      Date.now(),
      opp.id,
    );
    event = logFpEvent(opp.id, STATUS_EVENT_KIND[status] ?? "note", {
      from: opp.status,
      to: status,
      ...(note ? { note } : {}),
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const fresh = findFpOpportunity(opp.id)!;
  return { opp: fresh, event };
}

/**
 * Flag or unflag an opportunity — "pay attention to this" (migration 041).
 * flagged_at is written ONLY here: a priority call is a human judgement, so
 * every flip lands on the event trail with who made it and when. Setting the
 * state it already has is a no-op (changed: false, no event) so a re-run
 * cannot spam the audit trail. Flagging is attention, not urgency — the
 * deadline strips stay strictly deadline-ordered (see listFpOpportunities).
 */
export function setFpFlag(
  handle: string,
  flagged: boolean,
  opts: { by: string; note?: string | null; clientId?: ClientId },
): { opp: FpOpportunityRecord; event: FpEvent | null; changed: boolean } {
  if (!opts.by || !opts.by.trim()) {
    throw new Error("flag requires `by` — a priority call is a human judgement and must be attributed");
  }
  const opp = findFpOpportunity(handle, opts.clientId);
  if (!opp) throw new Error(`no opportunity matches: ${handle}`);
  if (flagged === (opp.flaggedAt != null)) {
    return { opp, event: null, changed: false };
  }
  const db = getDb();
  const now = Date.now();
  db.prepare("UPDATE fp_opportunities SET flagged_at = ?, updated_at = ? WHERE id = ?").run(
    flagged ? now : null,
    now,
    opp.id,
  );
  const event = logFpEvent(opp.id, flagged ? "flagged" : "unflagged", {
    by: opts.by.trim(),
    ...(opts.note ? { note: opts.note } : {}),
  });
  const fresh = findFpOpportunity(opp.id)!;
  return { opp: fresh, event, changed: true };
}

/**
 * Watch/unwatch a passed-deadline grant for its next cycle (migration 046 —
 * "remind when reopens"). reopen_watch_at is written ONLY here, so every
 * flip lands on the event trail with who made it. Same-state sets are a
 * no-op (changed: false, no event) so a re-click cannot spam the trail. The
 * discovery crons read the watch list each run and re-search those programs.
 */
export function setFpReopenWatch(
  handle: string,
  watch: boolean,
  opts: { by: string; note?: string | null; clientId?: ClientId },
): { opp: FpOpportunityRecord; event: FpEvent | null; changed: boolean } {
  if (!opts.by || !opts.by.trim()) {
    throw new Error("reopen watch requires `by` — a watch decision must be attributed");
  }
  const opp = findFpOpportunity(handle, opts.clientId);
  if (!opp) throw new Error(`no opportunity matches: ${handle}`);
  if (watch === (opp.reopenWatchAt != null)) {
    return { opp, event: null, changed: false };
  }
  const db = getDb();
  const now = Date.now();
  db.prepare("UPDATE fp_opportunities SET reopen_watch_at = ?, updated_at = ? WHERE id = ?").run(
    watch ? now : null,
    now,
    opp.id,
  );
  const event = logFpEvent(opp.id, "note", {
    action: watch ? "reopen_watch_set" : "reopen_watch_cleared",
    by: opts.by.trim(),
    ...(opts.note ? { note: opts.note } : {}),
  });
  const fresh = findFpOpportunity(opp.id)!;
  return { opp: fresh, event, changed: true };
}

export type ListFpFilters = {
  /**
   * Panel scope (migration 043). Optional here because the ops-wide surfaces
   * (dashboard, amendment watch) legitimately read across clients; the board
   * panels and the CLI always pass it.
   */
  clientId?: ClientId;
  status?: FpStatus;
  tier?: FpTier;
  source?: FpSource;
  /** Response deadline within N days from now (open-ended past excluded). */
  dueWithinDays?: number;
  limit?: number;
};

// Note: archived_at (migration 034) is deliberately NOT filtered here any
// more. The archive model was replaced by permanent delete + tombstones
// (migration 036, the operator's decision); the column stays so nothing breaks and
// any stranded archived rows are visible rather than lost.
export function listFpOpportunities(filters: ListFpFilters = {}): FpOpportunityRecord[] {
  const db = getDb();
  const where: string[] = ["1=1"];
  const params: Record<string, unknown> = {};
  if (filters.clientId) {
    where.push("client_id = @client_id");
    params.client_id = requireClientId(filters.clientId);
  }
  if (filters.status) {
    if (!isFpStatus(filters.status)) throw new Error(`invalid status: ${filters.status}`);
    where.push("status = @status");
    params.status = filters.status;
  }
  if (filters.tier) {
    if (!isFpTier(filters.tier)) throw new Error(`invalid tier: ${filters.tier}`);
    where.push("tier = @tier");
    params.tier = filters.tier;
  }
  if (filters.source) {
    if (!isFpSource(filters.source)) throw new Error(`invalid source: ${filters.source}`);
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters.dueWithinDays != null) {
    const n = Number(filters.dueWithinDays);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid dueWithinDays: ${filters.dueWithinDays}`);
    // ISO-8601 strings compare correctly against ISO bounds; rows with no
    // deadline are excluded from a due-within query by definition.
    where.push("response_deadline IS NOT NULL");
    where.push("datetime(response_deadline) >= datetime(@now)");
    where.push("datetime(response_deadline) <= datetime(@until)");
    params.now = new Date().toISOString();
    params.until = new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  }
  const limit = Math.min(Math.max(filters.limit ?? 500, 1), 1000);
  // Flagged rows first (migration 041), then the existing deadline order
  // within each group. This ordering feeds the Bid Board columns ONLY —
  // upcomingDeadlines and the "Next 14 days" strip re-sort strictly by
  // deadline, so a flag can never hide what runs out first.
  const rows = db
    .prepare(
      `SELECT * FROM fp_opportunities WHERE ${where.join(" AND ")}
       ORDER BY (flagged_at IS NULL), (response_deadline IS NULL), datetime(response_deadline) ASC, updated_at DESC
       LIMIT ${limit}`,
    )
    .all(params) as FpOppRow[];
  return rows.map(rowToOpp);
}

export function listFpEvents(oppId: string, limit = 200): FpEvent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM fp_events WHERE opp_id = ? ORDER BY ts DESC LIMIT ?")
    .all(oppId, limit) as FpEventRow[];
  return rows.map(rowToEvent);
}

/** Latest event of any of the given kinds per opportunity — one query. */
export function latestFpEventByOpp(kinds: FpEventKind[]): Map<string, FpEvent> {
  const db = getDb();
  const placeholders = kinds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.* FROM fp_events e
       JOIN (SELECT opp_id, MAX(ts) AS mts FROM fp_events WHERE kind IN (${placeholders}) GROUP BY opp_id) m
         ON m.opp_id = e.opp_id AND m.mts = e.ts
       WHERE e.kind IN (${placeholders})`,
    )
    .all(...kinds, ...kinds) as FpEventRow[];
  const out = new Map<string, FpEvent>();
  for (const r of rows) out.set(r.opp_id, rowToEvent(r));
  return out;
}

export function pendingFpApprovals(clientId?: ClientId): FpOpportunity[] {
  return listFpOpportunities({ status: "awaiting_approval", clientId });
}

export type FpOutcome = "won" | "lost" | "no_award";

const OUTCOME_STATUS: Record<FpOutcome, FpStatus> = {
  won: "closed_won",
  lost: "closed_lost",
  no_award: "closed_no_award",
};

export function recordFpOutcome(
  handle: string,
  outcome: FpOutcome,
  opts: { amount?: number | null; awardee?: string | null; notes?: string | null; clientId?: ClientId } = {},
): { opp: FpOpportunity; event: FpEvent } {
  const status = OUTCOME_STATUS[outcome];
  if (!status) throw new Error(`invalid outcome: ${outcome}`);
  const opp = findFpOpportunity(handle, opts.clientId);
  if (!opp) throw new Error(`no opportunity matches: ${handle}`);
  const db = getDb();
  // Same atomicity as setFpStatus: an outcome without its trail event is a
  // silent gap, so both writes share one transaction.
  db.exec("BEGIN IMMEDIATE");
  let event: FpEvent;
  try {
    db.prepare(
      `UPDATE fp_opportunities SET
         status = @status,
         result_award_amount = COALESCE(@amount, result_award_amount),
         result_awardee = COALESCE(@awardee, result_awardee),
         result_notes = COALESCE(@notes, result_notes),
         updated_at = @now
       WHERE id = @id`,
    ).run({
      id: opp.id,
      status,
      amount: opts.amount ?? null,
      awardee: opts.awardee ?? null,
      notes: opts.notes ?? null,
      now: Date.now(),
    });
    event = logFpEvent(opp.id, "outcome_recorded", {
      outcome,
      from: opp.status,
      ...(opts.amount != null ? { amount: opts.amount } : {}),
      ...(opts.awardee ? { awardee: opts.awardee } : {}),
      ...(opts.notes ? { notes: opts.notes } : {}),
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const fresh = findFpOpportunity(opp.id)!;
  return { opp: fresh, event };
}

// --- Bid Board editing + soft delete (migration 034) ------------------------

/**
 * Fields the operator may change from the Bid Board. Identity and provenance
 * (id, sol_number, notice_id, created_at) are deliberately absent — an edit
 * can never re-key or re-date a row, only correct what a human maintains.
 */
export type FpOpportunityEdit = {
  title?: string;
  agency?: string | null;
  office?: string | null;
  naics?: string | null;
  setAside?: string | null;
  noticeType?: string | null;
  tier?: FpTier | null;
  url?: string | null;
  responseDeadline?: string | null;
  priceQuoted?: number | null;
  priceBasis?: string | null;
  nobidReason?: string | null;
};

const EDIT_COLUMNS: Array<[keyof FpOpportunityEdit, string]> = [
  ["title", "title"],
  ["agency", "agency"],
  ["office", "office"],
  ["naics", "naics"],
  ["setAside", "set_aside"],
  ["noticeType", "notice_type"],
  ["tier", "tier"],
  ["url", "url"],
  ["responseDeadline", "response_deadline"],
  ["priceQuoted", "price_quoted"],
  ["priceBasis", "price_basis"],
  ["nobidReason", "nobid_reason"],
];

/**
 * Direct edit by exact id (no handle resolution — the board knows the row).
 * Only the columns in EDIT_COLUMNS can ever be written, so stray keys in
 * `edit` are ignored at runtime, not just rejected by the types. Throws on an
 * unknown id rather than upserting: an edit must never create a row.
 */
export function updateFpOpportunity(id: string, edit: FpOpportunityEdit): FpOpportunityRecord {
  if (edit.title !== undefined && !edit.title.trim()) throw new Error("title cannot be empty");
  if (edit.tier != null && !isFpTier(edit.tier)) throw new Error(`invalid tier: ${edit.tier}`);
  if (edit.priceQuoted != null && !Number.isFinite(Number(edit.priceQuoted))) {
    throw new Error(`invalid priceQuoted: ${edit.priceQuoted}`);
  }
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM fp_opportunities WHERE id = ?").get(id);
  if (!exists) throw new Error(`unknown opportunity id: ${id}`);

  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  const changed: string[] = [];
  for (const [key, col] of EDIT_COLUMNS) {
    if (edit[key] === undefined) continue;
    fields.push(`${col} = @${col}`);
    params[col] = key === "title" ? edit.title!.trim() : (edit[key] ?? null);
    changed.push(col);
  }
  if (edit.setAside !== undefined) {
    // Keep the canonical column in step with a board edit of the raw value.
    fields.push("set_aside_canonical = @set_aside_canonical");
    params.set_aside_canonical = normaliseSetAside(edit.setAside ?? null).canonical;
  }
  if (fields.length > 0) {
    fields.push("updated_at = @updated_at");
    params.updated_at = Date.now();
    db.prepare(`UPDATE fp_opportunities SET ${fields.join(", ")} WHERE id = @id`).run(params);
    // Field names only — values may be long free text and the row holds them.
    logFpEvent(id, "note", { action: "edited", fields: changed });
  }
  return findFpOpportunity(id)!;
}

// --- Permanent delete + tombstones (migration 036) --------------------------
//
// the operator's decision (2026-08-04), replacing the 034 archive model: "a no go
// means we wouldn't be able to service even in the future" — deleted means
// gone and it STAYS gone. Because both importers dedupe on natural keys, a
// bare DELETE would resurrect on the next sweep; the tombstone is what makes
// the delete permanent.

/** A record of a permanent delete. Carries enough to explain itself later. */
export type FpTombstone = {
  id: string;
  source: "federal" | "micro";
  noticeId: string | null;
  solNumber: string | null;
  title: string;
  agency: string | null;
  reason: string | null;
  deletedAt: number;
  deletedBy: string;
};

type TombstoneRow = {
  id: string;
  source: string;
  notice_id: string | null;
  sol_number: string | null;
  title: string;
  agency: string | null;
  reason: string | null;
  deleted_at: number;
  deleted_by: string;
};

function rowToTombstone(r: TombstoneRow): FpTombstone {
  return {
    id: r.id,
    source: r.source === "micro" ? "micro" : "federal",
    noticeId: r.notice_id,
    solNumber: r.sol_number,
    title: r.title,
    agency: r.agency,
    reason: r.reason,
    deletedAt: Number(r.deleted_at),
    deletedBy: r.deleted_by,
  };
}

/**
 * Does a tombstone block this natural key? Exact notice_id match first, then
 * sol_number — including the punctuation/case-normalised comparison, because
 * sol numbers arrive formatted inconsistently (the HT003826SC004 lesson) and
 * a re-formatted sol must not resurrect a deleted opportunity.
 */
export function findFpTombstone(
  noticeId: string | null | undefined,
  solNumber: string | null | undefined,
): FpTombstone | null {
  const db = getDb();
  if (noticeId) {
    const byNotice = db
      .prepare("SELECT * FROM deleted_opportunities WHERE source = 'federal' AND notice_id = ?")
      .get(noticeId) as TombstoneRow | undefined;
    if (byNotice) return rowToTombstone(byNotice);
  }
  if (solNumber) {
    const bySol = db
      .prepare("SELECT * FROM deleted_opportunities WHERE source = 'federal' AND sol_number = ?")
      .get(solNumber) as TombstoneRow | undefined;
    if (bySol) return rowToTombstone(bySol);
    const norm = normalizeSol(solNumber);
    if (norm) {
      const all = db
        .prepare("SELECT * FROM deleted_opportunities WHERE source = 'federal' AND sol_number IS NOT NULL")
        .all() as TombstoneRow[];
      const hit = all.find((r) => normalizeSol(r.sol_number ?? "") === norm);
      if (hit) return rowToTombstone(hit);
    }
  }
  return null;
}

/**
 * Permanently delete an opportunity by exact id. One transaction: write the
 * tombstone (keyed by the deleted row's id for provenance), remove the row's
 * fp_events (they would otherwise orphan), remove the row. There is no undo,
 * and the tombstone keeps importers from ever recreating it.
 */
export function deleteFpOpportunity(
  id: string,
  opts: { reason?: string | null; by: string },
): FpTombstone {
  const db = getDb();
  const row = db.prepare("SELECT * FROM fp_opportunities WHERE id = ?").get(id) as FpOppRow | undefined;
  if (!row) throw new Error(`unknown opportunity id: ${id}`);
  // AnyDb does not expose better-sqlite3's .transaction() helper (see the
  // note in lib/scouts.ts) — raw BEGIN IMMEDIATE, like lib/council.ts.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO deleted_opportunities
         (id, source, notice_id, sol_number, title, agency, reason, deleted_at, deleted_by)
       VALUES (?, 'federal', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.notice_id, row.sol_number, row.title, row.agency, opts.reason ?? null, Date.now(), opts.by);
    db.prepare("DELETE FROM fp_events WHERE opp_id = ?").run(row.id);
    db.prepare("DELETE FROM fp_opportunities WHERE id = ?").run(row.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const t = db
    .prepare("SELECT * FROM deleted_opportunities WHERE id = ?")
    .get(row.id) as TombstoneRow;
  return rowToTombstone(t);
}

/**
 * The stand-in returned when an ingest hits a tombstone. Built from the
 * tombstone, NEVER written to the database — it exists so callers that do not
 * check `skippedDeleted` (scripts outside this change) keep working without a
 * crash: created is false, so none of them log events or set dispositions on
 * it. Its id is the deleted row's original id.
 */
function tombstoneStandIn(t: FpTombstone, clientId: ClientId): FpOpportunityRecord {
  return {
    id: t.id,
    // The requesting ingest's client, NOT the deleting client — tombstones
    // are global (no client_id yet) and the stand-in only echoes the call.
    clientId,
    solNumber: t.solNumber,
    noticeId: t.noticeId,
    trackingNumber: null,
    title: t.title,
    agency: t.agency,
    description: null,
    reopenWatchAt: null,
    office: null,
    naics: null,
    setAside: null,
    setAsideCanonical: null,
    noticeType: null,
    tier: null,
    source: "other",
    url: null,
    responseDeadline: null,
    qaDeadline: null,
    popStart: null,
    popEnd: null,
    submissionMethod: null,
    submissionTarget: null,
    status: "withdrawn",
    nobidReason: t.reason,
    aiDeliverabilityScore: null,
    scoreBasis: null,
    scaleSignals: [],
    priceQuoted: null,
    priceBasis: null,
    competitorsEst: null,
    poc1Name: null,
    poc1Email: null,
    poc1Phone: null,
    poc2Name: null,
    poc2Email: null,
    poc2Phone: null,
    draftPaths: [],
    gmailDraftId: null,
    gmailSentIds: [],
    resultAwardAmount: null,
    resultAwardee: null,
    resultNotes: null,
    flaggedAt: null,
    createdAt: t.deletedAt,
    updatedAt: t.deletedAt,
    archivedAt: null,
  };
}
