import { randomUUID } from "crypto";
import { getDb } from "./db";

// Activity action types used across panes. Free-form, but standardizing
// here means filtering + reverse mapping (icon, color) stays consistent.
export const ACTION_TYPES = [
  "scout_ingested",
  "scout_promoted",
  "pool_status_changed",
  "pool_created",
  "draft_created",
  "draft_saved",
  "draft_status_changed",
  "draft_version_saved",
  "partner_manifest_changed",
  "suggestion_created",
  "suggestion_triaged",
  "suggestion_completed",
  "decision_created",
  "decision_resolved",
  "boilerplate_updated",
  "preflight_run",
  "alfred_tool_call",
  "auto_draft_created",
  "auto_draft_skipped",
  "auto_draft_blocked_memory_guard",
  "auto_draft_queued",
  "auto_draft_score_dropped",
  "apify_run",
  "apify_empty_run",
  "apify_failed_run",
  "apify_budget_exceeded",
  "apify_needs_human_review",
  "email_notification",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

// S9 Track B: watcher event taxonomy. Sources are the daily scout/watcher jobs
// that dual-write into the activity feed (Telegram digest stays live).
export const WATCHER_SOURCES = [
  "federal_awards",
  "county_procurement",
  "sam_gov",
  "usaspending",
  "behavioral_health",
  "foundations",
  "manual",
] as const;
export type WatcherSource = (typeof WATCHER_SOURCES)[number];

export const SEVERITIES = ["info", "warn", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const EXTENDED_EVENT_TYPES = [
  "scan_complete",
  "new_postings",
  "scan_failure_protection",
  "expirations_detected",
  "manual_override",
] as const;
export type ExtendedEventType = (typeof EXTENDED_EVENT_TYPES)[number];

export function isWatcherSource(s: string): s is WatcherSource {
  return (WATCHER_SOURCES as readonly string[]).includes(s);
}
export function isSeverity(s: string): s is Severity {
  return (SEVERITIES as readonly string[]).includes(s);
}
export function isExtendedEventType(s: string): s is ExtendedEventType {
  return (EXTENDED_EVENT_TYPES as readonly string[]).includes(s);
}

export type ActivityEntry = {
  id: string;
  createdAt: number;
  actor: string;
  actionType: ActionType | string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  // S9 Track B: optional structured watcher fields.
  source: WatcherSource | string | null;
  severity: Severity | null;
  eventTypeExtended: ExtendedEventType | string | null;
  newItemsCount: number | null;
  errorsCount: number | null;
  needsReview: boolean;
};

type Row = {
  id: string;
  created_at: number;
  actor: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  summary: string;
  detail_json: string | null;
  source: string | null;
  severity: string | null;
  event_type_extended: string | null;
  new_items_count: number | null;
  errors_count: number | null;
  needs_review: number | null;
};

function rowToEntry(r: Row): ActivityEntry {
  return {
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor,
    actionType: r.action_type,
    targetType: r.target_type,
    targetId: r.target_id,
    summary: r.summary,
    detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
    source: r.source ?? null,
    severity: r.severity && isSeverity(r.severity) ? r.severity : null,
    eventTypeExtended: r.event_type_extended ?? null,
    newItemsCount: r.new_items_count == null ? null : Number(r.new_items_count),
    errorsCount: r.errors_count == null ? null : Number(r.errors_count),
    needsReview: Number(r.needs_review ?? 0) === 1,
  };
}

export type LogActivityInput = {
  actor: string;
  actionType: ActionType | string;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  detail?: Record<string, unknown> | null;
};

export function logActivity(input: LogActivityInput): ActivityEntry {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO activity_log (id, created_at, actor, action_type, target_type, target_id, summary, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    now,
    input.actor,
    input.actionType,
    input.targetType ?? null,
    input.targetId ?? null,
    input.summary,
    input.detail ? JSON.stringify(input.detail) : null,
  );
  return {
    id,
    createdAt: now,
    actor: input.actor,
    actionType: input.actionType,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    summary: input.summary,
    detail: input.detail ?? null,
    source: null,
    severity: null,
    eventTypeExtended: null,
    newItemsCount: null,
    errorsCount: null,
    needsReview: false,
  };
}

// Returns activity in the last `windowMs` (default 7 days). Newest first.
export function listRecentActivity(opts?: {
  windowMs?: number;
  limit?: number;
  actionTypes?: string[];
  sources?: string[];
  severities?: string[];
  needsReviewOnly?: boolean;
}): ActivityEntry[] {
  const windowMs = opts?.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const limit = opts?.limit ?? 500;
  const since = Date.now() - windowMs;
  const db = getDb();
  let sql = `SELECT * FROM activity_log WHERE created_at >= ?`;
  const params: unknown[] = [since];
  if (opts?.actionTypes && opts.actionTypes.length > 0) {
    const placeholders = opts.actionTypes.map(() => "?").join(",");
    sql += ` AND action_type IN (${placeholders})`;
    params.push(...opts.actionTypes);
  }
  if (opts?.sources && opts.sources.length > 0) {
    const placeholders = opts.sources.map(() => "?").join(",");
    sql += ` AND source IN (${placeholders})`;
    params.push(...opts.sources);
  }
  if (opts?.severities && opts.severities.length > 0) {
    const placeholders = opts.severities.map(() => "?").join(",");
    sql += ` AND severity IN (${placeholders})`;
    params.push(...opts.severities);
  }
  if (opts?.needsReviewOnly) {
    sql += ` AND needs_review = 1`;
  }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as Row[];
  return rows.map(rowToEntry);
}

// Safe-fire wrapper — activity logging should never throw and kill a write.
export function tryLogActivity(input: LogActivityInput): void {
  try {
    logActivity(input);
  } catch {
    // Swallow — activity log is non-critical.
  }
}

// --- S9 Track B: watcher event ingestion -----------------------------------

export type WatcherEventInput = {
  source: WatcherSource;
  severity: Severity;
  eventType: ExtendedEventType;
  summary: string;
  newItemsCount?: number | null;
  errorsCount?: number | null;
  needsReview?: boolean;
  detail?: Record<string, unknown> | null;
};

export function ingestWatcherEvent(input: WatcherEventInput): ActivityEntry {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const actor = "watcher";
  // Legacy column is still populated so old pane filters and rowToEntry don't
  // see NULL action_type rows. Format: watcher_<eventType>.
  const actionType = `watcher_${input.eventType}`;
  const needsReview = input.needsReview ? 1 : 0;

  db.prepare(
    `INSERT INTO activity_log (
       id, created_at, actor, action_type, target_type, target_id, summary, detail_json,
       source, severity, event_type_extended, new_items_count, errors_count, needs_review
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    now,
    actor,
    actionType,
    null,
    null,
    input.summary,
    input.detail ? JSON.stringify(input.detail) : null,
    input.source,
    input.severity,
    input.eventType,
    input.newItemsCount ?? null,
    input.errorsCount ?? null,
    needsReview,
  );

  return {
    id,
    createdAt: now,
    actor,
    actionType,
    targetType: null,
    targetId: null,
    summary: input.summary,
    detail: input.detail ?? null,
    source: input.source,
    severity: input.severity,
    eventTypeExtended: input.eventType,
    newItemsCount: input.newItemsCount ?? null,
    errorsCount: input.errorsCount ?? null,
    needsReview: Boolean(input.needsReview),
  };
}
