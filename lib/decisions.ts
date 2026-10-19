import { randomUUID } from "crypto";
import {
  getDb,
  updatePool,
  isPoolStatus,
  getDraft,
  saveDraft,
  setOpportunityDisposition,
  isDraftStatus,
  setDraftStatus,
  type DraftStatus,
  type PoolStatus,
} from "./db";
import { isDisposition } from "./disposition";
import { readDraftRoster, upsertRosterEntry, writeRosterToMeta } from "./draft-partners";
import { createSuggestion } from "./suggestions";
import { notifyDecisionCreated } from "./email";
import { tryLogActivity } from "./activity";

export const DECISION_STATUSES = ["open", "decided", "deferred", "dismissed"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export function isDecisionStatus(s: string): s is DecisionStatus {
  return (DECISION_STATUSES as readonly string[]).includes(s);
}

// Side-effect kinds the decision queue can fire when resolved.
export const ACTION_KINDS = [
  "none",
  "set_pool_status",
  "set_partner_pairing",
  "set_draft_status",
  "add_suggestion",
  "set_opportunity_disposition",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type Decision = {
  id: string;
  createdAt: number;
  updatedAt: number;
  userEmail: string;
  question: string;
  contextType: string | null;
  contextId: string | null;
  options: string[];
  recommendedOption: string | null;
  recommendedReason: string | null;
  deadlineMs: number | null;
  status: DecisionStatus;
  decidedAt: number | null;
  decision: string | null;
  decisionNote: string | null;
  actionKind: ActionKind | null;
  actionPayload: Record<string, unknown> | null;
  actionStatus: "pending" | "fired" | "failed" | "skipped" | null;
};

type Row = {
  id: string;
  created_at: number;
  updated_at: number;
  user_email: string;
  question: string;
  context_type: string | null;
  context_id: string | null;
  options_json: string;
  recommended_option: string | null;
  recommended_reason: string | null;
  deadline_ms: number | null;
  status: string;
  decided_at: number | null;
  decision: string | null;
  decision_note: string | null;
  action_kind: string | null;
  action_payload: string | null;
  action_status: string | null;
};

function rowTo(r: Row): Decision {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    userEmail: r.user_email,
    question: r.question,
    contextType: r.context_type,
    contextId: r.context_id,
    options: JSON.parse(r.options_json) as string[],
    recommendedOption: r.recommended_option,
    recommendedReason: r.recommended_reason,
    deadlineMs: r.deadline_ms,
    status: isDecisionStatus(r.status) ? r.status : "open",
    decidedAt: r.decided_at,
    decision: r.decision,
    decisionNote: r.decision_note,
    actionKind: (r.action_kind as ActionKind | null) ?? null,
    actionPayload: r.action_payload ? (JSON.parse(r.action_payload) as Record<string, unknown>) : null,
    actionStatus: r.action_status as Decision["actionStatus"],
  };
}

export type CreateDecisionInput = {
  userEmail: string;
  question: string;
  contextType?: string | null;
  contextId?: string | null;
  options: string[];
  recommendedOption?: string | null;
  recommendedReason?: string | null;
  deadlineMs?: number | null;
  actionKind?: ActionKind | null;
  actionPayload?: Record<string, unknown> | null;
};

export function createDecision(input: CreateDecisionInput): Decision {
  if (!input.question.trim()) throw new Error("question required");
  if (!input.options || input.options.length === 0) throw new Error("options required");
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO decision_queue
       (id, created_at, updated_at, user_email, question, context_type, context_id, options_json,
        recommended_option, recommended_reason, deadline_ms, status, action_kind, action_payload, action_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
    .run(
      id,
      now,
      now,
      input.userEmail,
      input.question.trim(),
      input.contextType ?? null,
      input.contextId ?? null,
      JSON.stringify(input.options),
      input.recommendedOption ?? null,
      input.recommendedReason ?? null,
      input.deadlineMs ?? null,
      input.actionKind ?? null,
      input.actionPayload ? JSON.stringify(input.actionPayload) : null,
      input.actionKind && input.actionKind !== "none" ? "pending" : null,
    );
  tryLogActivity({
    actor: input.userEmail,
    actionType: "decision_created",
    targetType: "decision",
    targetId: id,
    summary: `Decision queued: ${input.question.slice(0, 100)}`,
  });
  // PENDING #1: fire-and-forget operator notification (no-op unless
  // RESEND_API_KEY + EMAIL_NOTIFICATIONS are both set; never throws).
  void notifyDecisionCreated({
    userEmail: input.userEmail,
    decisionId: id,
    question: input.question.trim(),
    recommendedOption: input.recommendedOption ?? null,
  });
  return getDecision(id) as Decision;
}

export function getDecision(id: string): Decision | null {
  const row = getDb()
    .prepare(`SELECT * FROM decision_queue WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? rowTo(row) : null;
}

export function listDecisions(opts?: {
  userEmail?: string;
  status?: DecisionStatus;
  limit?: number;
}): Decision[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts?.userEmail) {
    conds.push("user_email = ?");
    params.push(opts.userEmail);
  }
  if (opts?.status) {
    conds.push("status = ?");
    params.push(opts.status);
  }
  let sql = `SELECT * FROM decision_queue`;
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(opts?.limit ?? 500);
  const rows = getDb().prepare(sql).all(...params) as Row[];
  return rows.map(rowTo);
}

export function countOpenDecisions(userEmail: string): number {
  const r = getDb()
    .prepare(`SELECT COUNT(*) as n FROM decision_queue WHERE user_email = ? AND status = 'open'`)
    .get(userEmail) as { n: number } | undefined;
  return Number(r?.n ?? 0);
}

// Resolve a decision. If actionKind is set, fire the side-effect inline.
export function resolveDecision(input: {
  id: string;
  userEmail: string;
  status: "decided" | "deferred" | "dismissed";
  decision?: string;
  decisionNote?: string;
}): Decision | null {
  const existing = getDecision(input.id);
  if (!existing || existing.userEmail !== input.userEmail) return null;
  const now = Date.now();
  let actionStatus = existing.actionStatus;
  let actionErr: string | null = null;
  if (input.status === "decided" && existing.actionKind && existing.actionKind !== "none") {
    try {
      fireAction(existing, input.userEmail);
      actionStatus = "fired";
    } catch (err) {
      actionStatus = "failed";
      actionErr = err instanceof Error ? err.message : String(err);
    }
  } else if (input.status !== "decided" && existing.actionKind && existing.actionKind !== "none") {
    actionStatus = "skipped";
  }
  getDb()
    .prepare(
      `UPDATE decision_queue
         SET status = ?, updated_at = ?, decided_at = ?, decision = ?, decision_note = ?, action_status = ?
       WHERE id = ?`,
    )
    .run(
      input.status,
      now,
      input.status === "decided" ? now : null,
      input.decision ?? null,
      input.decisionNote ?? null,
      actionStatus,
      input.id,
    );
  tryLogActivity({
    actor: input.userEmail,
    actionType: "decision_resolved",
    targetType: "decision",
    targetId: input.id,
    summary: `Decision ${input.status}${input.decision ? ` → ${input.decision}` : ""}${actionErr ? ` (action failed: ${actionErr})` : ""}`,
  });
  return getDecision(input.id);
}

function fireAction(decision: Decision, userEmail: string): void {
  if (!decision.actionKind || decision.actionKind === "none") return;
  const payload = decision.actionPayload ?? {};
  switch (decision.actionKind) {
    case "set_pool_status": {
      const poolId = String(payload.poolId ?? "");
      const status = String(payload.status ?? "");
      if (!poolId) throw new Error("poolId missing");
      if (!isPoolStatus(status)) throw new Error(`invalid status ${status}`);
      const result = updatePool(poolId, userEmail, { status: status as PoolStatus });
      if (!result) throw new Error(`pool ${poolId} not found`);
      return;
    }
    case "set_partner_pairing": {
      const draftId = String(payload.draftId ?? "");
      const partnerId = String(payload.partnerId ?? "");
      if (!draftId) throw new Error("draftId missing");
      const d = getDraft(draftId, userEmail);
      if (!d) throw new Error(`draft ${draftId} not found`);
      let meta = { ...(d.meta ?? {}) } as Record<string, unknown>;
      // Keep the legacy singleton for audit/back-compat...
      meta.partnerLead = {
        partnerId,
        partnerName: payload.partnerName ?? null,
        decidedAt: Date.now(),
      };
      // ...and upsert the paired partner onto the Item 4.1 curated roster as an
      // included prime, so pairing stays consistent with the per-draft roster.
      if (partnerId) {
        const roster = upsertRosterEntry(readDraftRoster(d.meta), {
          partnerId,
          role: "prime",
          included: true,
        });
        meta = writeRosterToMeta(meta, roster);
      }
      saveDraft({
        id: d.id,
        userEmail,
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
      return;
    }
    case "set_opportunity_disposition": {
      // Item 3.1: close the win/loss loop straight from the Decision Queue.
      const opportunityId = String(payload.opportunityId ?? "");
      const disposition = String(payload.disposition ?? "");
      const note =
        typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : null;
      if (!opportunityId) throw new Error("opportunityId missing");
      if (!isDisposition(disposition)) throw new Error(`invalid disposition ${disposition}`);
      const result = setOpportunityDisposition(opportunityId, userEmail, disposition, note);
      if (!result) throw new Error(`opportunity ${opportunityId} not found`);
      return;
    }
    case "set_draft_status": {
      // PENDING #3 (implemented 2026-06-09): move a draft through its lifecycle
      // via the CANONICAL status helper (drafting | submitted | won | lost).
      // "submitted" is refused here for the same reason the Alfred tool refuses
      // it: submission must go through the pre-flight-gated
      // POST /api/drafts/[id]/status — a resolved decision must not bypass it.
      const draftId = String(payload.draftId ?? "");
      const status = String(payload.status ?? "");
      if (!draftId) throw new Error("draftId missing");
      if (!isDraftStatus(status)) throw new Error(`invalid status ${status}`);
      if (status === "submitted") {
        throw new Error(
          "decisions cannot mark a draft submitted — use the pre-flight-gated status endpoint",
        );
      }
      const ok = setDraftStatus({ draftId, userEmail, status: status as DraftStatus });
      if (!ok) throw new Error(`draft ${draftId} not found`);
      return;
    }
    case "add_suggestion": {
      // PENDING #4 (implemented 2026-06-09): resolving the decision drops a
      // suggestion into the target pane's SuggestionInbox. Pane context falls
      // back to the decision's own context so callers rarely need to set it.
      const body = String(payload.body ?? "").trim();
      if (!body) throw new Error("body missing");
      const paneContextType =
        typeof payload.paneContextType === "string" && payload.paneContextType.trim()
          ? payload.paneContextType.trim()
          : decision.contextType;
      const paneContextId =
        typeof payload.paneContextId === "string" && payload.paneContextId.trim()
          ? payload.paneContextId.trim()
          : decision.contextId;
      createSuggestion({ userEmail, paneContextType, paneContextId, body });
      return;
    }
    default:
      throw new Error(`unknown action_kind ${decision.actionKind}`);
  }
}
