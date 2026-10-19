/**
 * Sprint 7 — Auto-draft trigger.
 *
 * Single entry point: `tryAutoDraft({ kind, sourceId, score, userEmail })`.
 * Call this from any scoring-write site (saved opp strategic, NOFO model score,
 * future tool wrappers). It handles:
 *
 *   - kill-switch (env AUTO_DRAFT_ENABLED + alfred_settings override)
 *   - configurable threshold (default 80/100, settable via alfred_settings)
 *   - idempotency (one draft per opportunity_key in auto_draft_log)
 *   - 3-per-24h rate limit (4th hit goes to auto_draft_queue + Suggestion Inbox)
 *   - deadline-passed skip
 *   - no-partner-matched flag (still creates draft)
 *   - memory-guard intercept BEFORE persist (server-side Jane Barred block)
 *   - 8(a) auto-select ELCGL when setaside flag matches
 *   - draft assembly from boilerplate + NOFO + partner manifest + rationale
 *   - preflight run + RED surface
 *   - activity_log entry + suggestion_created + mutation event
 *   - score-drop watcher: re-scoring an opportunity AFTER an auto-draft exists
 *     flags the draft if the new score falls below either (a) the original
 *     trigger score or (b) the current threshold
 *
 * The brief speaks in "10-point scale" terms ("≥ 8/10") but the actual
 * scorers (lib/scoring.ts model + lib/strategic-scoring.ts deterministic)
 * both produce 0–100 composite scores. The translated threshold is 80.
 */

import { randomUUID } from "crypto";
import {
  getDb,
  getSavedOpportunity,
  getNofo,
  getDraft,
  saveDraft,
  setDraftStatus,
  type SavedOpportunity,
  type NofoRecord,
  type DraftRecord,
} from "./db";
import { tryLogActivity } from "./activity";
import { emitMutation } from "./events";
import { createSuggestion } from "./suggestions";
import {
  listBoilerplate,
  listReusableBoilerplate,
  pinBoilerplateToDraft,
  type BoilerplateBlock,
} from "./boilerplate";
import {
  selectPartnersForOpportunity,
  scorePartnersForLead,
  type PartnerWithBody,
} from "./partners";
import { createDecision } from "./decisions";
import { runPreflightById, type PreflightResult } from "./preflight";
import { enforceMemoryGuards } from "./copilot-context";
import { emptySections, type SectionMap } from "./sections";

// ---- Settings -------------------------------------------------------------

export const AUTO_DRAFT_THRESHOLD_DEFAULT = 80;
export const AUTO_DRAFT_RATE_LIMIT_24H = 3;
export const AUTO_DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;

function ensureSettingsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS alfred_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function getSetting<T>(key: string, fallback: T): T {
  ensureSettingsTable();
  const row = getDb()
    .prepare(`SELECT value_json FROM alfred_settings WHERE key = ?`)
    .get(key) as { value_json: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  ensureSettingsTable();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO alfred_settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), now);
}

export function getAutoDraftEnabled(): boolean {
  // env wins as kill switch; UI toggle overrides default when env is unset.
  const envFlag = process.env.AUTO_DRAFT_ENABLED?.trim().toLowerCase();
  if (envFlag === "false" || envFlag === "0" || envFlag === "off") return false;
  return getSetting<boolean>("auto_draft:enabled", true);
}

export function getAutoDraftThreshold(): number {
  const stored = getSetting<number>("auto_draft:threshold", AUTO_DRAFT_THRESHOLD_DEFAULT);
  const n = Number(stored);
  if (!Number.isFinite(n) || n < 0 || n > 100) return AUTO_DRAFT_THRESHOLD_DEFAULT;
  return n;
}

// ---- Log + queue persistence ---------------------------------------------

export type AutoDraftOutcome =
  | "created"
  | "skipped"
  | "blocked_memory_guard"
  | "queued";

export type AutoDraftLogEntry = {
  id: string;
  createdAt: number;
  userEmail: string;
  opportunityKey: string;
  sourceKind: "saved_opportunity" | "nofo";
  sourceId: string;
  score: number;
  threshold: number;
  outcome: AutoDraftOutcome;
  reason: string | null;
  draftId: string | null;
  detail: Record<string, unknown> | null;
};

type LogRow = {
  id: string;
  created_at: number;
  user_email: string;
  opportunity_key: string;
  source_kind: string;
  source_id: string;
  score: number;
  threshold: number;
  outcome: string;
  reason: string | null;
  draft_id: string | null;
  detail_json: string | null;
};

function rowToLog(r: LogRow): AutoDraftLogEntry {
  return {
    id: r.id,
    createdAt: r.created_at,
    userEmail: r.user_email,
    opportunityKey: r.opportunity_key,
    sourceKind: (r.source_kind as "saved_opportunity" | "nofo") ?? "saved_opportunity",
    sourceId: r.source_id,
    score: Number(r.score),
    threshold: Number(r.threshold),
    outcome: (r.outcome as AutoDraftOutcome) ?? "skipped",
    reason: r.reason,
    draftId: r.draft_id,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
  };
}

function writeLog(input: Omit<AutoDraftLogEntry, "id" | "createdAt">): AutoDraftLogEntry {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO auto_draft_log
         (id, created_at, user_email, opportunity_key, source_kind, source_id,
          score, threshold, outcome, reason, draft_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      now,
      input.userEmail,
      input.opportunityKey,
      input.sourceKind,
      input.sourceId,
      input.score,
      input.threshold,
      input.outcome,
      input.reason ?? null,
      input.draftId ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
    );
  return { ...input, id, createdAt: now };
}

export function listAutoDraftLog(opts?: {
  userEmail?: string;
  limit?: number;
}): AutoDraftLogEntry[] {
  const limit = opts?.limit ?? 100;
  const params: unknown[] = [];
  let sql = `SELECT * FROM auto_draft_log`;
  if (opts?.userEmail) {
    sql += ` WHERE user_email = ?`;
    params.push(opts.userEmail);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params) as LogRow[];
  return rows.map(rowToLog);
}

function findExistingDraftForOpportunity(opportunityKey: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT draft_id FROM auto_draft_log
        WHERE opportunity_key = ? AND outcome = 'created' AND draft_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(opportunityKey) as { draft_id: string } | undefined;
  return row?.draft_id ?? null;
}

function countCreatedInWindow(userEmail: string, windowMs: number): number {
  const since = Date.now() - windowMs;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as n FROM auto_draft_log
        WHERE user_email = ? AND outcome = 'created' AND created_at >= ?`,
    )
    .get(userEmail, since) as { n: number };
  return Number(row?.n ?? 0);
}

function upsertQueueRow(input: {
  userEmail: string;
  opportunityKey: string;
  sourceKind: "saved_opportunity" | "nofo";
  sourceId: string;
  score: number;
  threshold: number;
}): { queueId: string } {
  const id = randomUUID();
  const now = Date.now();
  try {
    getDb()
      .prepare(
        `INSERT INTO auto_draft_queue
           (id, created_at, user_email, opportunity_key, source_kind, source_id, score, threshold)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        now,
        input.userEmail,
        input.opportunityKey,
        input.sourceKind,
        input.sourceId,
        input.score,
        input.threshold,
      );
    return { queueId: id };
  } catch (err) {
    // UNIQUE(opportunity_key) — already queued; return existing id.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      const existing = getDb()
        .prepare(
          `SELECT id FROM auto_draft_queue WHERE opportunity_key = ? AND released_at IS NULL`,
        )
        .get(input.opportunityKey) as { id: string } | undefined;
      return { queueId: existing?.id ?? id };
    }
    throw err;
  }
}

export type AutoDraftQueueEntry = {
  id: string;
  createdAt: number;
  userEmail: string;
  opportunityKey: string;
  sourceKind: "saved_opportunity" | "nofo";
  sourceId: string;
  score: number;
  threshold: number;
  releasedAt: number | null;
  releasedDraftId: string | null;
};

type QueueRow = {
  id: string;
  created_at: number;
  user_email: string;
  opportunity_key: string;
  source_kind: string;
  source_id: string;
  score: number;
  threshold: number;
  released_at: number | null;
  released_draft_id: string | null;
};

function rowToQueue(r: QueueRow): AutoDraftQueueEntry {
  return {
    id: r.id,
    createdAt: r.created_at,
    userEmail: r.user_email,
    opportunityKey: r.opportunity_key,
    sourceKind: (r.source_kind as "saved_opportunity" | "nofo") ?? "saved_opportunity",
    sourceId: r.source_id,
    score: Number(r.score),
    threshold: Number(r.threshold),
    releasedAt: r.released_at == null ? null : Number(r.released_at),
    releasedDraftId: r.released_draft_id,
  };
}

export function listAutoDraftQueue(opts?: {
  userEmail?: string;
  openOnly?: boolean;
}): AutoDraftQueueEntry[] {
  const params: unknown[] = [];
  let sql = `SELECT * FROM auto_draft_queue WHERE 1=1`;
  if (opts?.userEmail) {
    sql += ` AND user_email = ?`;
    params.push(opts.userEmail);
  }
  if (opts?.openOnly) {
    sql += ` AND released_at IS NULL`;
  }
  sql += ` ORDER BY created_at DESC`;
  const rows = getDb().prepare(sql).all(...params) as QueueRow[];
  return rows.map(rowToQueue);
}

// ---- Draft assembly -------------------------------------------------------

type AutoDraftInput = {
  kind: "saved_opportunity" | "nofo";
  sourceId: string;
  score: number;
  userEmail: string;
};

type AssemblyContext = {
  title: string;             // human display name of the opportunity
  opportunityKey: string;    // idempotency key
  shortName: string;         // used in "[AUTO] {shortName}"
  deadlineMs: number | null; // for deadline-passed check
  scoringRationale: string;  // pre-fills exec summary
  bodyForPartnerMatch: string;
  setasideIsEightA: boolean;
  nofoId: string | null;
  sourceOpp: SavedOpportunity | null;
  sourceNofo: NofoRecord | null;
  // Required-section list for header in narrative.
  requiredSections: string[];
};

function shortNameOf(s: string): string {
  // First sentence or first 60 chars.
  const firstSentence = s.split(/[.!?]/)[0].trim();
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57).trim() + "…";
}

function parseDeadline(deadline: string | null | undefined): number | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

async function buildContext(input: AutoDraftInput): Promise<AssemblyContext | null> {
  if (input.kind === "saved_opportunity") {
    const opp = getSavedOpportunity(input.sourceId, input.userEmail);
    if (!opp) return null;
    const rationaleSrc =
      (opp.strategicScoreDetail?.summary as string | undefined) ??
      `Strategic score ${opp.strategicScore ?? input.score}/100. Recommendation: ${
        (opp.strategicScoreDetail?.recommendation as string | undefined) ?? "pursue"
      }.`;
    const bodyText = [opp.title, opp.agency, opp.summary, opp.eligibility]
      .filter(Boolean)
      .join(" ");
    const setaside = /8\s*\(?\s*a\s*\)?|set[- ]aside/i.test(bodyText);
    return {
      title: opp.title,
      opportunityKey: `opp:${opp.id}`,
      shortName: shortNameOf(opp.title),
      deadlineMs: parseDeadline(opp.deadline),
      scoringRationale: rationaleSrc,
      bodyForPartnerMatch: bodyText,
      setasideIsEightA: setaside,
      nofoId: null,
      sourceOpp: opp,
      sourceNofo: null,
      requiredSections: [],
    };
  }
  const nofo = getNofo(input.sourceId, input.userEmail);
  if (!nofo) return null;
  const rationaleSrc =
    nofo.scoreRationale ?? `Model fit score ${nofo.score ?? input.score}/100.`;
  const bodyText = [nofo.program, nofo.agency, nofo.summary, nofo.eligibility]
    .filter(Boolean)
    .join(" ");
  const setaside = /8\s*\(?\s*a\s*\)?|set[- ]aside/i.test(bodyText);
  const deadline =
    nofo.keyDates && typeof nofo.keyDates === "object"
      ? (nofo.keyDates as Record<string, unknown>).application_due as string | undefined
      : undefined;
  return {
    title: nofo.program ?? nofo.originalFilename ?? `NOFO ${nofo.id.slice(0, 8)}`,
    opportunityKey: `nofo:${nofo.id}`,
    shortName: shortNameOf(nofo.program ?? nofo.originalFilename ?? `NOFO ${nofo.id.slice(0, 8)}`),
    deadlineMs: parseDeadline(deadline ?? null),
    scoringRationale: rationaleSrc,
    bodyForPartnerMatch: bodyText,
    setasideIsEightA: setaside,
    nofoId: nofo.id,
    sourceOpp: null,
    sourceNofo: nofo,
    requiredSections: nofo.requiredSections ?? [],
  };
}

// Compose the narrative for each draft section using latest-pinned boilerplate
// + NOFO context + partner manifest. Output is a SectionMap whose values are
// markdown strings (matches the existing draft format).
function composeSections(args: {
  ctx: AssemblyContext;
  score: number;
  blocks: BoilerplateBlock[];
  partners: PartnerWithBody[];
  partnerSelectionReason: string;
}): { sections: SectionMap; insertedBlockKeys: string[]; partnerLines: string[] } {
  const { ctx, score, blocks, partners, partnerSelectionReason } = args;
  const byKey = new Map(blocks.map((b) => [b.key, b]));

  const sections: SectionMap = { ...emptySections() };
  const insertedBlockKeys: string[] = [];

  const includeBlock = (key: string): string => {
    const b = byKey.get(key);
    if (!b) return "";
    insertedBlockKeys.push(b.key);
    return b.bodyMarkdown.trim();
  };

  // Executive summary — scoring rationale + win-thesis prose.
  const execHeader = `# Why we win (auto-drafted at score ${Math.round(score)}/100)\n\n${ctx.scoringRationale}\n`;
  const winBullets: string[] = [
    `- Opportunity: ${ctx.title}`,
    ctx.sourceOpp?.agency ? `- Agency: ${ctx.sourceOpp.agency}` : "",
    ctx.sourceNofo?.agency ? `- Agency: ${ctx.sourceNofo.agency}` : "",
    ctx.sourceOpp?.deadline ? `- Deadline: ${ctx.sourceOpp.deadline}` : "",
    `- Applicant: Acme Consulting Group LLC (NJ MBE; 8(a) application in progress)`,
  ].filter(Boolean);
  sections.executive_summary = `${execHeader}\n${winBullets.join("\n")}\n`;

  // Capability statement — boilerplate cap statement + NAICS block.
  const cap = includeBlock("acme-consulting-capability-statement");
  const naics = includeBlock("acme-consulting-naics-codes");
  const uei = includeBlock("acme-consulting-uei");
  const mbe = includeBlock("acme-consulting-mbe-cert");
  const eighta = includeBlock("acme-consulting-8a-status");
  sections.capability_statement = [cap, naics, uei, mbe, eighta]
    .filter(Boolean)
    .join("\n\n");

  // Technical approach — partner manifest + reference to NOFO required sections.
  const partnerLines: string[] = [];
  if (partners.length) {
    partnerLines.push("## Consortium configuration");
    partnerLines.push(`Selection basis: ${partnerSelectionReason}.`);
    partnerLines.push("");
    for (const p of partners) {
      partnerLines.push(`- **${p.name}** (${p.type || "partner"})${p.capabilities.length ? ` — ${p.capabilities.slice(0, 4).join(", ")}` : ""}`);
    }
  } else {
    partnerLines.push("## Consortium configuration");
    partnerLines.push("_No warm partner match. the operator to assign consortium prior to submission._");
  }
  const requiredSectionNote = ctx.requiredSections.length
    ? `\n\n## NOFO required sections (verify before submission)\n${ctx.requiredSections.map((s) => `- ${s}`).join("\n")}`
    : "";
  sections.technical_approach = partnerLines.join("\n") + requiredSectionNote;

  // Past performance — Harbor County boilerplate.
  const harbor = includeBlock("harbor-county-track-record");
  sections.past_performance = harbor;

  // Reviewer notes — DEI scrub block + signature page stub + contact + Dr. Reed.
  const climate = includeBlock("federal-political-climate-language");
  const contact = includeBlock("acme-consulting-contact-info");
  const reed = includeBlock("dr-reed-cv-summary");
  sections.reviewer_notes = [
    "## Auto-draft notes for reviewer",
    "",
    "_This draft was assembled automatically when the strategic fit crossed threshold. the operator, review carefully before any submission action._",
    "",
    "**Signatory:** [insert signed signature page before submission]",
    "",
    climate,
    "",
    "---",
    "",
    reed,
    "",
    "---",
    "",
    contact,
  ]
    .filter(Boolean)
    .join("\n");

  return { sections, insertedBlockKeys, partnerLines };
}

// ---- Partner-lead decision ------------------------------------------------

// When an auto-draft is created, rank the matched partners and surface a
// "who should lead?" decision so the operator sees the recommended prime and how
// to write them as lead. Non-critical: any failure here must not abort the
// draft, so callers wrap in try/catch and we also guard internally.
async function emitPartnerLeadDecision(args: {
  draftId: string;
  userEmail: string;
  opportunityTitle: string;
  opportunityText: string;
  candidateIds: string[];
}): Promise<void> {
  if (!args.candidateIds.length) return;
  const ranking = await scorePartnersForLead({
    opportunityText: args.opportunityText,
    candidateIds: args.candidateIds,
  });
  const best = ranking.best;
  if (!best) return;

  const options = ranking.ranked.slice(0, 4).map((p) => `${p.name} (${p.score}/100)`);
  const recommendedOption = `${best.name} (${best.score}/100)`;
  const leadWith =
    best.matchedCapabilities.slice(0, 2).join(" and ") || "their core capabilities";
  const recommendedReason =
    `Top-ranked lead — ${best.rationale}. ` +
    `Write ${best.name} as the prime: open the technical approach with ${leadWith}, ` +
    `name them first in the consortium configuration, and frame remaining partners as subcontractors.`;

  createDecision({
    userEmail: args.userEmail,
    question: `Who should lead the draft "${args.opportunityTitle}"?`,
    contextType: "draft",
    contextId: args.draftId,
    options,
    recommendedOption,
    recommendedReason,
    actionKind: "set_partner_pairing",
    actionPayload: { draftId: args.draftId, partnerId: best.id, partnerName: best.name },
  });
}

// ---- Score-drop watcher ---------------------------------------------------

function flagDraftScoreDropped(args: {
  draftId: string;
  userEmail: string;
  oldScore: number;
  newScore: number;
  threshold: number;
  reason: string;
}): void {
  const d = getDraft(args.draftId, args.userEmail);
  if (!d) return;
  const meta = { ...(d.meta ?? {}) } as Record<string, unknown>;
  const existing = (meta.flags as Record<string, unknown> | undefined) ?? {};
  meta.flags = {
    ...existing,
    score_dropped_after_autodraft: {
      at: Date.now(),
      from: args.oldScore,
      to: args.newScore,
      threshold: args.threshold,
      reason: args.reason,
    },
  };
  saveDraft({
    id: d.id,
    userEmail: args.userEmail,
    title: d.title,
    business: d.business,
    naics: d.naics,
    opportunity: d.opportunity,
    blocks: d.blocks,
    structured: d.structured,
    sections: d.sections,
    meta,
    nofoId: d.nofoId,
    poolId: d.poolId,
  });
  tryLogActivity({
    actor: args.userEmail,
    actionType: "auto_draft_score_dropped",
    targetType: "draft",
    targetId: d.id,
    summary: `Score for auto-draft "${d.title}" dropped ${args.oldScore} → ${args.newScore} (threshold ${args.threshold}).`,
  });
}

// Public — call from any scoring-write site BEFORE the trigger check, since
// this only acts when an auto-draft already exists for the same opportunity.
export function watchScoreDrop(input: {
  kind: "saved_opportunity" | "nofo";
  sourceId: string;
  newScore: number;
  userEmail: string;
}): void {
  const opportunityKey = `${input.kind === "saved_opportunity" ? "opp" : "nofo"}:${input.sourceId}`;
  // Most recent created log row for this opportunity.
  const row = getDb()
    .prepare(
      `SELECT score, draft_id FROM auto_draft_log
        WHERE opportunity_key = ? AND outcome = 'created' AND draft_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(opportunityKey) as { score: number; draft_id: string } | undefined;
  if (!row) return;
  const threshold = getAutoDraftThreshold();
  const oldScore = Number(row.score);
  if (input.newScore >= oldScore && input.newScore >= threshold) return;
  // Drop below original score OR below threshold — flag it.
  flagDraftScoreDropped({
    draftId: row.draft_id,
    userEmail: input.userEmail,
    oldScore,
    newScore: input.newScore,
    threshold,
    reason: input.newScore < threshold ? "below_threshold" : "below_original",
  });
}

// ---- Trigger entry point --------------------------------------------------

export type AutoDraftAttemptResult = {
  outcome: AutoDraftOutcome;
  reason: string | null;
  draftId: string | null;
  log: AutoDraftLogEntry | null;
};

export async function tryAutoDraft(input: AutoDraftInput): Promise<AutoDraftAttemptResult> {
  // 0) Watch for score drops on existing auto-drafts (independent of trigger).
  watchScoreDrop({
    kind: input.kind,
    sourceId: input.sourceId,
    newScore: input.score,
    userEmail: input.userEmail,
  });

  const threshold = getAutoDraftThreshold();

  // 1) Threshold check
  if (input.score < threshold) {
    return { outcome: "skipped", reason: "below_threshold", draftId: null, log: null };
  }

  // 2) Kill switch
  if (!getAutoDraftEnabled()) {
    const log = writeLog({
      userEmail: input.userEmail,
      opportunityKey: `${input.kind === "saved_opportunity" ? "opp" : "nofo"}:${input.sourceId}`,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      score: input.score,
      threshold,
      outcome: "skipped",
      reason: "auto_draft_disabled",
      draftId: null,
      detail: null,
    });
    return { outcome: "skipped", reason: "auto_draft_disabled", draftId: null, log };
  }

  // 3) Build context (resolves the opportunity/NOFO)
  const ctx = await buildContext(input);
  if (!ctx) {
    return { outcome: "skipped", reason: "source_not_found", draftId: null, log: null };
  }

  // 4) Idempotency — already created for this opportunity?
  const existingDraftId = findExistingDraftForOpportunity(ctx.opportunityKey);
  if (existingDraftId) {
    const log = writeLog({
      userEmail: input.userEmail,
      opportunityKey: ctx.opportunityKey,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      score: input.score,
      threshold,
      outcome: "skipped",
      reason: "already_exists",
      draftId: existingDraftId,
      detail: null,
    });
    return { outcome: "skipped", reason: "already_exists", draftId: existingDraftId, log };
  }

  // 5) Deadline-passed skip
  if (ctx.deadlineMs != null && ctx.deadlineMs < Date.now()) {
    const log = writeLog({
      userEmail: input.userEmail,
      opportunityKey: ctx.opportunityKey,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      score: input.score,
      threshold,
      outcome: "skipped",
      reason: "deadline_passed",
      draftId: null,
      detail: null,
    });
    return { outcome: "skipped", reason: "deadline_passed", draftId: null, log };
  }

  // 6) Rate-limit (3 per 24h). If exceeded → queue + skip.
  const createdRecently = countCreatedInWindow(input.userEmail, AUTO_DRAFT_WINDOW_MS);
  if (createdRecently >= AUTO_DRAFT_RATE_LIMIT_24H) {
    upsertQueueRow({
      userEmail: input.userEmail,
      opportunityKey: ctx.opportunityKey,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      score: input.score,
      threshold,
    });
    const log = writeLog({
      userEmail: input.userEmail,
      opportunityKey: ctx.opportunityKey,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      score: input.score,
      threshold,
      outcome: "queued",
      reason: "rate_limit_24h",
      draftId: null,
      detail: { createdInWindow: createdRecently, limit: AUTO_DRAFT_RATE_LIMIT_24H },
    });
    // Surface to Suggestion Inbox so the operator can release.
    try {
      createSuggestion({
        userEmail: input.userEmail,
        paneContextType: "auto_draft_queue",
        paneContextId: ctx.opportunityKey,
        body: `Auto-draft queued (rate limit hit): ${ctx.title} — score ${Math.round(input.score)}/100. Release from /settings.`,
      });
    } catch {
      // suggestion failure is non-critical
    }
    emitMutation({
      type: "suggestion_created",
      userEmail: input.userEmail,
      at: Date.now(),
      autoDraftQueued: true,
      opportunityKey: ctx.opportunityKey,
    });
    return { outcome: "queued", reason: "rate_limit_24h", draftId: null, log };
  }

  // 7) Partner auto-match
  const partnerSel = await selectPartnersForOpportunity({
    opportunityText: ctx.bodyForPartnerMatch,
  }).catch(() => ({ partners: [] as PartnerWithBody[], selection: { reason: "none" as const, ids: [] as string[] } }));
  const partners = partnerSel.partners;
  const noPartnerMatched =
    !partners.length || partnerSel.selection.reason === "none" || partnerSel.selection.reason === "fallback_all";

  // 8) Compose draft sections (boilerplate + NOFO + partners + rationale)
  // Reuse-gated: expired, unapproved, superseded, funder-restricted and
  // DO_NOT_REUSE blocks never reach a draft (V4.1 §14.9).
  const { usable: blocks, withheld } = listReusableBoilerplate({
    funder: ctx.sourceNofo?.agency ?? null,
    external: true,
  });
  if (withheld.length) {
    // Surfaced, not silently dropped — a reviewer needs to see that a block was
    // excluded and why.
    tryLogActivity({
      actor: "system",
      actionType: "boilerplate_withheld",
      targetType: "draft",
      targetId: ctx.opportunityKey,
      summary: `${withheld.length} boilerplate block(s) withheld from auto-draft`,
      detail: { withheld: withheld.map((w) => ({ key: w.block.key, reason: w.reason })) },
    });
  }
  const composed = composeSections({
    ctx,
    score: input.score,
    blocks,
    partners,
    partnerSelectionReason: partnerSel.selection.reason,
  });

  // 9) Memory guard at composition time — abort if banned name slipped in.
  const fullText = Object.values(composed.sections).join("\n\n");
  const guard = enforceMemoryGuards(fullText);
  if (guard.flagged.length > 0) {
    const log = writeLog({
      userEmail: input.userEmail,
      opportunityKey: ctx.opportunityKey,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      score: input.score,
      threshold,
      outcome: "blocked_memory_guard",
      reason: "banned_name_in_assembly",
      draftId: null,
      detail: { flagged: guard.flagged },
    });
    tryLogActivity({
      actor: input.userEmail,
      actionType: "auto_draft_blocked_memory_guard",
      targetType: "opportunity",
      targetId: input.sourceId,
      summary: `Auto-draft blocked by memory guard: ${guard.flagged.join(", ")}.`,
    });
    try {
      createSuggestion({
        userEmail: input.userEmail,
        paneContextType: "auto_draft_blocked",
        paneContextId: ctx.opportunityKey,
        body: `Auto-draft blocked by memory guard (${guard.flagged.join(", ")}) for "${ctx.title}". Review boilerplate before retry.`,
      });
    } catch {
      // non-critical
    }
    return { outcome: "blocked_memory_guard", reason: "banned_name_in_assembly", draftId: null, log };
  }

  // 10) 8(a) auto-select ELCGL (currently the only applicant we support, but
  //     this preserves the brief's intent: if the NOFO is 8(a) setaside, the
  //     applicant block defaults to Acme Consulting Group LLC even if
  //     auto-matched partners would otherwise be passed as the prime).
  const business = ctx.setasideIsEightA ? "Acme Consulting Group LLC" : "Acme Consulting Group LLC";

  // 11) Persist the draft, then pin boilerplate versions.
  const title = `[AUTO] ${ctx.shortName} — score ${Math.round(input.score)}/100`;
  const saved = saveDraft({
    userEmail: input.userEmail,
    title,
    business,
    naics: "541611",
    opportunity: ctx.title,
    blocks: [],
    structured: null,
    sections: composed.sections,
    meta: {
      autoDrafted: true,
      triggerScore: input.score,
      threshold,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      opportunityKey: ctx.opportunityKey,
      partnerSelection: {
        reason: partnerSel.selection.reason,
        ids: partners.map((p) => p.id),
        matchedKeywords:
          "matchedKeywords" in partnerSel.selection
            ? partnerSel.selection.matchedKeywords ?? []
            : [],
      },
      flags: noPartnerMatched ? { no_partner_matched: { at: Date.now() } } : {},
    } satisfies Record<string, unknown>,
    nofoId: ctx.nofoId,
    poolId: null,
  });

  // Flip status to auto_drafted (saveDraft preserves status default 'drafting').
  setDraftStatus({
    draftId: saved.id,
    userEmail: input.userEmail,
    status: "auto_drafted",
  });

  // Pin each inserted boilerplate block to capture the version.
  for (const key of composed.insertedBlockKeys) {
    try {
      pinBoilerplateToDraft({ draftId: saved.id, blockKey: key, positionHint: "auto_draft" });
    } catch {
      // best-effort
    }
  }

  // 12) Run preflight so RED items surface immediately in /drafts/[id].
  let preflight: PreflightResult | null = null;
  try {
    preflight = runPreflightById(saved.id, input.userEmail, {
      samGovLastRenewed: process.env.EL_SAM_GOV_LAST_RENEWED?.trim() || undefined,
      ueiOnFile: process.env.EL_UEI?.trim() || undefined,
      partnerLettersDates: (process.env.EL_PARTNER_LETTER_DATES?.trim() || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  } catch {
    preflight = null;
  }

  // 13) Activity log + suggestion inbox + event
  tryLogActivity({
    actor: input.userEmail,
    actionType: "auto_draft_created",
    targetType: "draft",
    targetId: saved.id,
    summary: `Auto-drafted "${ctx.title}" at score ${Math.round(input.score)}/100${
      preflight ? ` — preflight ${preflight.redCount}R / ${preflight.yellowCount}Y / ${preflight.greenCount}G` : ""
    }.`,
  });
  try {
    createSuggestion({
      userEmail: input.userEmail,
      paneContextType: "draft",
      paneContextId: saved.id,
      body: `Auto-draft ready for review: ${ctx.title}, score ${Math.round(input.score)}/100${
        preflight && preflight.redCount > 0 ? ` (${preflight.redCount} RED items to address)` : ""
      } — open /drafts/${saved.id}.`,
    });
  } catch {
    // non-critical
  }
  emitMutation({
    type: "draft_status_changed",
    userEmail: input.userEmail,
    at: Date.now(),
    draftId: saved.id,
    autoDrafted: true,
    score: input.score,
  });

  // Surface the recommended lead partner as a decision (non-critical).
  try {
    await emitPartnerLeadDecision({
      draftId: saved.id,
      userEmail: input.userEmail,
      opportunityTitle: ctx.title,
      opportunityText: ctx.bodyForPartnerMatch,
      candidateIds: partners.map((p) => p.id),
    });
  } catch {
    // non-critical — draft already persisted
  }

  const log = writeLog({
    userEmail: input.userEmail,
    opportunityKey: ctx.opportunityKey,
    sourceKind: input.kind,
    sourceId: input.sourceId,
    score: input.score,
    threshold,
    outcome: "created",
    reason: null,
    draftId: saved.id,
    detail: {
      preflight: preflight
        ? { red: preflight.redCount, yellow: preflight.yellowCount, green: preflight.greenCount }
        : null,
      partners: partners.map((p) => ({ id: p.id, name: p.name })),
      noPartnerMatched,
      eightA: ctx.setasideIsEightA,
    },
  });

  return { outcome: "created", reason: null, draftId: saved.id, log };
}

// ---- Queue release --------------------------------------------------------

// Manually release a queued auto-draft. Bypasses the rate limit (operator
// intent), but still goes through tryAutoDraft so all the other guardrails
// apply (idempotency, memory guard, deadline).
export async function releaseQueuedAutoDraft(
  queueId: string,
  userEmail: string,
): Promise<AutoDraftAttemptResult> {
  const row = getDb()
    .prepare(`SELECT * FROM auto_draft_queue WHERE id = ? AND user_email = ?`)
    .get(queueId, userEmail) as QueueRow | undefined;
  if (!row) return { outcome: "skipped", reason: "queue_not_found", draftId: null, log: null };
  if (row.released_at) {
    return { outcome: "skipped", reason: "already_released", draftId: row.released_draft_id, log: null };
  }
  // Temporarily widen rate limit by deleting this row's slot influence —
  // simpler: just call tryAutoDraft directly and if it queues again (rate
  // still hit), the existing queue row is reused (UNIQUE constraint).
  // To bypass the rate limit, we artificially set a flag.
  const result = await tryAutoDraftBypassRate({
    kind: row.source_kind as "saved_opportunity" | "nofo",
    sourceId: row.source_id,
    score: Number(row.score),
    userEmail,
  });
  if (result.outcome === "created" && result.draftId) {
    getDb()
      .prepare(`UPDATE auto_draft_queue SET released_at = ?, released_draft_id = ? WHERE id = ?`)
      .run(Date.now(), result.draftId, queueId);
  }
  return result;
}

// Internal: same as tryAutoDraft but skips the rate-limit branch. Used by the
// queue-release path so the operator can release a queued auto-draft manually
// without re-tripping the limit that caused it to queue in the first place.
async function tryAutoDraftBypassRate(input: AutoDraftInput): Promise<AutoDraftAttemptResult> {
  const threshold = getAutoDraftThreshold();
  if (input.score < threshold) {
    return { outcome: "skipped", reason: "below_threshold", draftId: null, log: null };
  }
  if (!getAutoDraftEnabled()) {
    return { outcome: "skipped", reason: "auto_draft_disabled", draftId: null, log: null };
  }
  const ctx = await buildContext(input);
  if (!ctx) return { outcome: "skipped", reason: "source_not_found", draftId: null, log: null };
  const existingDraftId = findExistingDraftForOpportunity(ctx.opportunityKey);
  if (existingDraftId) {
    return { outcome: "skipped", reason: "already_exists", draftId: existingDraftId, log: null };
  }
  if (ctx.deadlineMs != null && ctx.deadlineMs < Date.now()) {
    return { outcome: "skipped", reason: "deadline_passed", draftId: null, log: null };
  }
  // (rate-limit branch skipped on purpose)
  const partnerSel = await selectPartnersForOpportunity({ opportunityText: ctx.bodyForPartnerMatch }).catch(() => ({
    partners: [] as PartnerWithBody[],
    selection: { reason: "none" as const, ids: [] as string[] },
  }));
  const partners = partnerSel.partners;
  const noPartnerMatched =
    !partners.length || partnerSel.selection.reason === "none" || partnerSel.selection.reason === "fallback_all";
  const { usable: blocks } = listReusableBoilerplate({ funder: ctx.sourceNofo?.agency ?? null, external: true });
  const composed = composeSections({
    ctx,
    score: input.score,
    blocks,
    partners,
    partnerSelectionReason: partnerSel.selection.reason,
  });
  const fullText = Object.values(composed.sections).join("\n\n");
  const guard = enforceMemoryGuards(fullText);
  if (guard.flagged.length > 0) {
    const log = writeLog({
      userEmail: input.userEmail,
      opportunityKey: ctx.opportunityKey,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      score: input.score,
      threshold,
      outcome: "blocked_memory_guard",
      reason: "banned_name_in_assembly",
      draftId: null,
      detail: { flagged: guard.flagged },
    });
    return { outcome: "blocked_memory_guard", reason: "banned_name_in_assembly", draftId: null, log };
  }
  const title = `[AUTO] ${ctx.shortName} — score ${Math.round(input.score)}/100`;
  const saved = saveDraft({
    userEmail: input.userEmail,
    title,
    business: "Acme Consulting Group LLC",
    naics: "541611",
    opportunity: ctx.title,
    blocks: [],
    structured: null,
    sections: composed.sections,
    meta: {
      autoDrafted: true,
      triggerScore: input.score,
      threshold,
      sourceKind: input.kind,
      sourceId: input.sourceId,
      opportunityKey: ctx.opportunityKey,
      releasedFromQueue: true,
      partnerSelection: {
        reason: partnerSel.selection.reason,
        ids: partners.map((p) => p.id),
      },
      flags: noPartnerMatched ? { no_partner_matched: { at: Date.now() } } : {},
    },
    nofoId: ctx.nofoId,
    poolId: null,
  });
  setDraftStatus({ draftId: saved.id, userEmail: input.userEmail, status: "auto_drafted" });
  for (const key of composed.insertedBlockKeys) {
    try {
      pinBoilerplateToDraft({ draftId: saved.id, blockKey: key, positionHint: "auto_draft" });
    } catch {
      // best-effort
    }
  }
  let preflight: PreflightResult | null = null;
  try {
    preflight = runPreflightById(saved.id, input.userEmail);
  } catch {
    preflight = null;
  }
  const log = writeLog({
    userEmail: input.userEmail,
    opportunityKey: ctx.opportunityKey,
    sourceKind: input.kind,
    sourceId: input.sourceId,
    score: input.score,
    threshold,
    outcome: "created",
    reason: "released_from_queue",
    draftId: saved.id,
    detail: {
      preflight: preflight
        ? { red: preflight.redCount, yellow: preflight.yellowCount, green: preflight.greenCount }
        : null,
    },
  });
  tryLogActivity({
    actor: input.userEmail,
    actionType: "auto_draft_created",
    targetType: "draft",
    targetId: saved.id,
    summary: `Auto-draft released from queue: "${ctx.title}" at score ${Math.round(input.score)}/100.`,
  });
  emitMutation({
    type: "draft_status_changed",
    userEmail: input.userEmail,
    at: Date.now(),
    draftId: saved.id,
    autoDrafted: true,
    releasedFromQueue: true,
    score: input.score,
  });
  try {
    await emitPartnerLeadDecision({
      draftId: saved.id,
      userEmail: input.userEmail,
      opportunityTitle: ctx.title,
      opportunityText: ctx.bodyForPartnerMatch,
      candidateIds: partners.map((p) => p.id),
    });
  } catch {
    // non-critical — draft already persisted
  }
  return { outcome: "created", reason: "released_from_queue", draftId: saved.id, log };
}

// Re-export DraftRecord for callers that want to look up an auto-draft.
export type { DraftRecord };
