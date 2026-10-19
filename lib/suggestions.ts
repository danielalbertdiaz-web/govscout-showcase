import { randomUUID } from "crypto";
import { getDb } from "./db";
import { tryLogActivity } from "./activity";

export const SUGGESTION_STATUSES = ["open", "triaged", "done"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export function isSuggestionStatus(s: string): s is SuggestionStatus {
  return (SUGGESTION_STATUSES as readonly string[]).includes(s);
}

export type Suggestion = {
  id: string;
  createdAt: number;
  updatedAt: number;
  userEmail: string;
  paneContextType: string | null;
  paneContextId: string | null;
  body: string;
  status: SuggestionStatus;
  triagedAt: number | null;
  completedAt: number | null;
  resolutionNote: string | null;
};

type Row = {
  id: string;
  created_at: number;
  updated_at: number;
  user_email: string;
  pane_context_type: string | null;
  pane_context_id: string | null;
  body: string;
  status: string;
  triaged_at: number | null;
  completed_at: number | null;
  resolution_note: string | null;
};

function rowTo(r: Row): Suggestion {
  return {
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    userEmail: r.user_email,
    paneContextType: r.pane_context_type,
    paneContextId: r.pane_context_id,
    body: r.body,
    status: isSuggestionStatus(r.status) ? r.status : "open",
    triagedAt: r.triaged_at,
    completedAt: r.completed_at,
    resolutionNote: r.resolution_note,
  };
}

export type CreateSuggestionInput = {
  userEmail: string;
  paneContextType?: string | null;
  paneContextId?: string | null;
  body: string;
};

export function createSuggestion(input: CreateSuggestionInput): Suggestion {
  const trimmed = input.body.trim();
  if (!trimmed) throw new Error("body is required");
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO suggestions (id, created_at, updated_at, user_email, pane_context_type, pane_context_id, body, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    )
    .run(
      id,
      now,
      now,
      input.userEmail,
      input.paneContextType ?? null,
      input.paneContextId ?? null,
      trimmed,
    );
  tryLogActivity({
    actor: input.userEmail,
    actionType: "suggestion_created",
    targetType: input.paneContextType ?? "suggestion",
    targetId: input.paneContextId ?? id,
    summary: `New suggestion: ${trimmed.slice(0, 100)}${trimmed.length > 100 ? "…" : ""}`,
  });
  return getSuggestion(id, input.userEmail) as Suggestion;
}

export function getSuggestion(id: string, userEmail: string): Suggestion | null {
  const row = getDb()
    .prepare(`SELECT * FROM suggestions WHERE id = ? AND user_email = ?`)
    .get(id, userEmail) as Row | undefined;
  return row ? rowTo(row) : null;
}

export function listSuggestions(opts?: {
  userEmail?: string;
  status?: SuggestionStatus;
  paneContextType?: string;
  paneContextId?: string;
  limit?: number;
}): Suggestion[] {
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
  if (opts?.paneContextType) {
    conds.push("pane_context_type = ?");
    params.push(opts.paneContextType);
  }
  if (opts?.paneContextId) {
    conds.push("pane_context_id = ?");
    params.push(opts.paneContextId);
  }
  let sql = `SELECT * FROM suggestions`;
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(opts?.limit ?? 200);
  const rows = getDb().prepare(sql).all(...params) as Row[];
  return rows.map(rowTo);
}

export function updateSuggestionStatus(
  id: string,
  userEmail: string,
  status: SuggestionStatus,
  resolutionNote?: string,
): Suggestion | null {
  const existing = getSuggestion(id, userEmail);
  if (!existing) return null;
  const now = Date.now();
  const triagedAt = status === "triaged" && !existing.triagedAt ? now : existing.triagedAt;
  const completedAt = status === "done" ? now : existing.completedAt;
  getDb()
    .prepare(
      `UPDATE suggestions
         SET status = ?, updated_at = ?, triaged_at = ?, completed_at = ?, resolution_note = COALESCE(?, resolution_note)
       WHERE id = ?`,
    )
    .run(status, now, triagedAt, completedAt, resolutionNote ?? null, id);
  tryLogActivity({
    actor: userEmail,
    actionType:
      status === "triaged"
        ? "suggestion_triaged"
        : status === "done"
          ? "suggestion_completed"
          : "suggestion_created",
    targetType: existing.paneContextType ?? "suggestion",
    targetId: existing.paneContextId ?? id,
    summary: `Suggestion ${status}: ${existing.body.slice(0, 80)}${existing.body.length > 80 ? "…" : ""}`,
  });
  return getSuggestion(id, userEmail);
}

export function deleteSuggestion(id: string, userEmail: string): boolean {
  const existing = getSuggestion(id, userEmail);
  if (!existing) return false;
  const res = getDb().prepare(`DELETE FROM suggestions WHERE id = ? AND user_email = ?`).run(id, userEmail);
  return res.changes > 0;
}
