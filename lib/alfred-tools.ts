/**
 * Alfred Tools — server-side registry of all functions Alfred can call.
 *
 * Each tool has:
 *  - name, description, args schema (sketched as a TS type + a small
 *    human-readable signature so we can dump it into Alfred's prompt)
 *  - exec(): the actual function that runs server-side
 *  - kind: "read" | "view" | "write" — used to gate destructive calls
 *
 * Tool invocation contract for the Alfred chat loop:
 *  - the operator can fire any tool directly via the /api/alfred/tools API
 *  - Alfred (the LLM) can request a tool by emitting a marker in its reply:
 *      <tool_call name="filter_scouts" args='{"agency":"Harbor"}' />
 *    The server post-processes the streamed reply, executes the tool, and
 *    publishes a mutation event so panes can refresh.
 *
 * This lives separate from claude-cli.ts because the CLI invocation strips
 * tool support; Alfred's tool-use is implemented as a markup convention on
 * top of the prose stream, not via the Anthropic native tool-use protocol.
 * The trade-off is documented; if/when we move Alfred to native tool-use,
 * each tool's exec() becomes the handler for that tool's name.
 */

import { randomUUID } from "crypto";
import { getDb, getPool, updatePool, getDraft, saveDraft, isDraftStatus, setDraftStatus, isPoolStatus, listPools, listDrafts, getSavedOpportunity, setOpportunityStrategicScore, type PoolStatus, type DraftStatus } from "./db";
import { computeStrategicScore } from "./strategic-scoring";
import { listAllItems } from "./scouts";
import { listPartners, loadPartners } from "./partners";
import { createSuggestion } from "./suggestions";
import { createDecision, listDecisions, type ActionKind } from "./decisions";
import { listRecentActivity, logActivity, tryLogActivity, type ActionType } from "./activity";
import { pinBoilerplateToDraft, getBoilerplate } from "./boilerplate";
import { runPreflightById } from "./preflight";
import type { SectionMap } from "./sections";

export type ToolKind = "read" | "view" | "write" | "scoring";

export type ToolSpec = {
  name: string;
  kind: ToolKind;
  description: string;
  signature: string;
  exec: (args: Record<string, unknown>, ctx: { userEmail: string }) => Promise<unknown> | unknown;
};

export type ToolCallRecord = {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  error: string | null;
  ranAtMs: number;
};

// ---------- READ TOOLS ------------------------------------------------------

const read_pane_state: ToolSpec = {
  name: "read_pane_state",
  kind: "read",
  description: "Inspect a pane's filters/pins. Pane is one of: scouts, pools, drafts, partners, decisions, activity.",
  signature: "read_pane_state(pane: string) -> { pane, items, count }",
  exec: ({ pane }, { userEmail }) => {
    const p = String(pane);
    switch (p) {
      case "scouts": {
        const items = listAllItems(userEmail, {}).slice(0, 25);
        return { pane: p, count: items.length, items: items.map((i) => ({ id: i.id, title: i.title, status: i.status, score: i.score })) };
      }
      case "pools": {
        const items = listPools(userEmail);
        return { pane: p, count: items.length, items: items.map((i) => ({ id: i.id, name: i.name, status: i.status })) };
      }
      case "drafts": {
        const items = listDrafts(userEmail, 25);
        return { pane: p, count: items.length, items: items.map((i) => ({ id: i.id, title: i.title })) };
      }
      case "partners":
        return { pane: p, items: listPartners() };
      case "decisions":
        return { pane: p, items: listDecisions({ userEmail, status: "open" }) };
      case "activity":
        return { pane: p, items: listRecentActivity({ limit: 25 }) };
      default:
        throw new Error(`unknown pane: ${p}`);
    }
  },
};

const read_activity: ToolSpec = {
  name: "read_activity",
  kind: "read",
  description: "Recent activity log entries. Default last 24h.",
  signature: "read_activity(since_hours?: number, limit?: number) -> { entries }",
  exec: ({ since_hours, limit }) => {
    const hrs = typeof since_hours === "number" && since_hours > 0 ? since_hours : 24;
    const lim = typeof limit === "number" ? limit : 50;
    return {
      entries: listRecentActivity({ windowMs: hrs * 60 * 60 * 1000, limit: lim }),
    };
  },
};

const read_decisions: ToolSpec = {
  name: "read_decisions",
  kind: "read",
  description: "List decisions. status filter optional: open|decided|deferred|dismissed.",
  signature: "read_decisions(status?: string) -> { decisions }",
  exec: ({ status }, { userEmail }) => {
    const s = typeof status === "string" ? status : "open";
    return {
      decisions: listDecisions({
        userEmail,
        status: ["open", "decided", "deferred", "dismissed"].includes(s)
          ? (s as "open" | "decided" | "deferred" | "dismissed")
          : "open",
      }),
    };
  },
};

const read_partners: ToolSpec = {
  name: "read_partners",
  kind: "read",
  description: "Partner manifest. Optional capability filter.",
  signature: "read_partners(capability?: string) -> { partners }",
  exec: async ({ capability }) => {
    const partners = await loadPartners();
    if (typeof capability === "string" && capability.trim()) {
      const lc = capability.toLowerCase();
      return {
        partners: partners.filter((p) =>
          p.capabilities.some((c) => c.toLowerCase().includes(lc)),
        ),
      };
    }
    return { partners };
  },
};

const search_scouts: ToolSpec = {
  name: "search_scouts",
  kind: "read",
  description: "Keyword + minimum-score search across scout items.",
  signature: "search_scouts(query?: string, score_min?: number) -> { items }",
  exec: ({ query, score_min }, { userEmail }) => {
    const q = typeof query === "string" ? query.toLowerCase().trim() : "";
    const scoreMin = typeof score_min === "number" ? score_min : 0;
    const items = listAllItems(userEmail, {});
    const filtered = items.filter((i) => {
      if (scoreMin > 0 && (i.score ?? 0) < scoreMin) return false;
      if (!q) return true;
      const blob = `${i.title} ${i.agency ?? ""} ${i.rawText}`.toLowerCase();
      return blob.includes(q);
    });
    return { items: filtered.slice(0, 25).map((i) => ({ id: i.id, title: i.title, score: i.score, status: i.status })) };
  },
};

// ---------- VIEW / FILTER TOOLS --------------------------------------------
// These mutate per-user view state (pins/hidden sources/priority/highlights)
// stored in a small key-value table so the UI can read them on next render.

type ViewKind = "pin" | "highlight" | "priority" | "hidden_source" | "saved_filter";

function ensureViewStateTable(): void {
  // Lazy create — no migration needed for Alfred's UI state.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS alfred_view_state (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      kind TEXT NOT NULL,
      pane TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      value_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(user_email, kind, pane, target_type, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_avs_user_pane ON alfred_view_state(user_email, pane);
  `);
}

function upsertViewState(input: {
  userEmail: string;
  kind: ViewKind;
  pane: string;
  targetType?: string | null;
  targetId?: string | null;
  value?: unknown;
}): { id: string } {
  ensureViewStateTable();
  const id = randomUUID();
  const now = Date.now();
  try {
    getDb()
      .prepare(
        `INSERT INTO alfred_view_state (id, user_email, kind, pane, target_type, target_id, value_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_email, kind, pane, target_type, target_id)
         DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at`,
      )
      .run(
        id,
        input.userEmail,
        input.kind,
        input.pane,
        input.targetType ?? null,
        input.targetId ?? null,
        input.value !== undefined ? JSON.stringify(input.value) : null,
        now,
      );
  } catch (err) {
    // Some SQLite versions emit constraint-error pre-upsert; ignore harmlessly.
    if (!(err instanceof Error && /UNIQUE/.test(err.message))) throw err;
  }
  return { id };
}

function deleteViewState(input: {
  userEmail: string;
  kind: ViewKind;
  pane: string;
  targetType?: string | null;
  targetId?: string | null;
}): number {
  ensureViewStateTable();
  const res = getDb()
    .prepare(
      `DELETE FROM alfred_view_state
        WHERE user_email = ? AND kind = ? AND pane = ?
          AND COALESCE(target_type, '') = COALESCE(?, '')
          AND COALESCE(target_id, '') = COALESCE(?, '')`,
    )
    .run(
      input.userEmail,
      input.kind,
      input.pane,
      input.targetType ?? null,
      input.targetId ?? null,
    );
  return res.changes;
}

export function listViewState(userEmail: string, pane?: string): Array<{
  kind: ViewKind;
  pane: string;
  targetType: string | null;
  targetId: string | null;
  value: unknown;
}> {
  ensureViewStateTable();
  const params: unknown[] = [userEmail];
  let sql = `SELECT kind, pane, target_type, target_id, value_json FROM alfred_view_state WHERE user_email = ?`;
  if (pane) {
    sql += ` AND pane = ?`;
    params.push(pane);
  }
  const rows = getDb().prepare(sql).all(...params) as Array<{
    kind: string;
    pane: string;
    target_type: string | null;
    target_id: string | null;
    value_json: string | null;
  }>;
  return rows.map((r) => ({
    kind: r.kind as ViewKind,
    pane: r.pane,
    targetType: r.target_type,
    targetId: r.target_id,
    value: r.value_json ? JSON.parse(r.value_json) : null,
  }));
}

const pin_item: ToolSpec = {
  name: "pin_item",
  kind: "view",
  description: "Pin a scout/pool/draft to the top of its pane.",
  signature: "pin_item(type: scout|pool|draft, id: string) -> { ok }",
  exec: ({ type, id }, { userEmail }) => {
    const pane = `${type}s`;
    upsertViewState({ userEmail, kind: "pin", pane, targetType: String(type), targetId: String(id), value: true });
    tryLogActivity({ actor: userEmail, actionType: "alfred_tool_call", targetType: String(type), targetId: String(id), summary: `Pinned ${type}:${String(id).slice(0,8)} to top of ${pane}` });
    return { ok: true, pane, targetType: type, targetId: id };
  },
};

const unpin_item: ToolSpec = {
  name: "unpin_item",
  kind: "view",
  description: "Unpin a previously pinned item.",
  signature: "unpin_item(type: scout|pool|draft, id: string) -> { ok }",
  exec: ({ type, id }, { userEmail }) => {
    const pane = `${type}s`;
    const removed = deleteViewState({ userEmail, kind: "pin", pane, targetType: String(type), targetId: String(id) });
    tryLogActivity({ actor: userEmail, actionType: "alfred_tool_call", targetType: String(type), targetId: String(id), summary: `Unpinned ${type}:${String(id).slice(0,8)}` });
    return { ok: removed > 0 };
  },
};

const hide_source: ToolSpec = {
  name: "hide_source",
  kind: "view",
  description: "Hide a scouts source (e.g. 'foundation', 'sam_gov') from the Scouts pane.",
  signature: "hide_source(source: string) -> { ok }",
  exec: ({ source }, { userEmail }) => {
    upsertViewState({ userEmail, kind: "hidden_source", pane: "scouts", targetType: "source", targetId: String(source), value: true });
    tryLogActivity({ actor: userEmail, actionType: "alfred_tool_call", targetType: "scouts", targetId: String(source), summary: `Hidden source: ${source}` });
    return { ok: true };
  },
};

const show_source: ToolSpec = {
  name: "show_source",
  kind: "view",
  description: "Un-hide a scouts source.",
  signature: "show_source(source: string) -> { ok }",
  exec: ({ source }, { userEmail }) => {
    const removed = deleteViewState({ userEmail, kind: "hidden_source", pane: "scouts", targetType: "source", targetId: String(source) });
    tryLogActivity({ actor: userEmail, actionType: "alfred_tool_call", targetType: "scouts", targetId: String(source), summary: `Re-shown source: ${source}` });
    return { ok: removed > 0 };
  },
};

const highlight_item: ToolSpec = {
  name: "highlight_item",
  kind: "view",
  description: "Color-tag an item. color: amber|emerald|rose|sky|violet|stone.",
  signature: "highlight_item(type: string, id: string, color: string) -> { ok }",
  exec: ({ type, id, color }, { userEmail }) => {
    const pane = `${type}s`;
    upsertViewState({ userEmail, kind: "highlight", pane, targetType: String(type), targetId: String(id), value: { color: String(color) } });
    tryLogActivity({ actor: userEmail, actionType: "alfred_tool_call", targetType: String(type), targetId: String(id), summary: `Highlighted ${type}:${String(id).slice(0,8)} → ${color}` });
    return { ok: true };
  },
};

const set_priority: ToolSpec = {
  name: "set_priority",
  kind: "view",
  description: "Boost item priority (1-5).",
  signature: "set_priority(type: string, id: string, level: number) -> { ok }",
  exec: ({ type, id, level }, { userEmail }) => {
    const n = Math.max(1, Math.min(5, Number(level) || 1));
    const pane = `${type}s`;
    upsertViewState({ userEmail, kind: "priority", pane, targetType: String(type), targetId: String(id), value: { level: n } });
    tryLogActivity({ actor: userEmail, actionType: "alfred_tool_call", targetType: String(type), targetId: String(id), summary: `Set priority ${n} on ${type}:${String(id).slice(0,8)}` });
    return { ok: true, level: n };
  },
};

const filter_scouts: ToolSpec = {
  name: "filter_scouts",
  kind: "view",
  description: "Apply a saved filter to the scouts pane. Stored under user's saved filters.",
  signature: "filter_scouts(criteria: object) -> { ok }",
  exec: ({ criteria, name }, { userEmail }) => {
    const filterName = typeof name === "string" ? name : "default";
    upsertViewState({ userEmail, kind: "saved_filter", pane: "scouts", targetType: "filter", targetId: filterName, value: criteria ?? {} });
    tryLogActivity({ actor: userEmail, actionType: "alfred_tool_call", targetType: "scouts", targetId: filterName, summary: `Applied filter "${filterName}" to Scouts` });
    return { ok: true, name: filterName };
  },
};

const navigate: ToolSpec = {
  name: "navigate",
  kind: "view",
  description: "Suggest a pane the operator should switch to. Returns the URL; the UI emits a navigation event.",
  signature: "navigate(route: string) -> { route }",
  exec: ({ route }) => {
    const r = String(route).startsWith("/") ? String(route) : `/${route}`;
    return { route: r };
  },
};

// ---------- WRITE TOOLS -----------------------------------------------------

const add_suggestion: ToolSpec = {
  name: "add_suggestion",
  kind: "write",
  description: "Capture a 'do X about this' suggestion in the inbox.",
  signature: "add_suggestion(pane_context_type: string, pane_context_id?: string, body: string) -> { id }",
  exec: ({ pane_context_type, pane_context_id, body }, { userEmail }) => {
    const s = createSuggestion({
      userEmail,
      paneContextType: String(pane_context_type),
      paneContextId: pane_context_id ? String(pane_context_id) : null,
      body: String(body),
    });
    return { id: s.id };
  },
};

const add_decision: ToolSpec = {
  name: "add_decision",
  kind: "write",
  description: "File a decision into the Decision Queue.",
  signature: "add_decision(question: string, options: string[], recommended?: string, context_type?: string, context_id?: string, action_kind?: string, action_payload?: object) -> { id }",
  exec: ({ question, options, recommended, context_type, context_id, action_kind, action_payload }, { userEmail }) => {
    const d = createDecision({
      userEmail,
      question: String(question),
      options: Array.isArray(options) ? options.map(String) : [],
      recommendedOption: recommended ? String(recommended) : null,
      contextType: context_type ? String(context_type) : null,
      contextId: context_id ? String(context_id) : null,
      actionKind: typeof action_kind === "string" ? (action_kind as ActionKind) : null,
      actionPayload: typeof action_payload === "object" && action_payload !== null ? (action_payload as Record<string, unknown>) : null,
    });
    return { id: d.id };
  },
};

const update_pool_status: ToolSpec = {
  name: "update_pool_status",
  kind: "write",
  description: "Move a funding pool to a new lifecycle status. Logs the change.",
  signature: "update_pool_status(pool_id: string, status: string, note?: string) -> { ok }",
  exec: ({ pool_id, status, note }, { userEmail }) => {
    if (!isPoolStatus(String(status))) throw new Error(`invalid status ${status}`);
    const before = getPool(String(pool_id), userEmail);
    const updated = updatePool(String(pool_id), userEmail, { status: status as PoolStatus });
    if (!updated) throw new Error(`pool not found: ${pool_id}`);
    tryLogActivity({
      actor: userEmail,
      actionType: "pool_status_changed",
      targetType: "pool",
      targetId: String(pool_id),
      summary: `Alfred set ${updated.name}: ${before?.status ?? "?"} → ${status}${note ? ` — ${note}` : ""}`,
    });
    return { ok: true, pool_id, status };
  },
};

const update_draft_status: ToolSpec = {
  name: "update_draft_status",
  kind: "write",
  description: "Move a draft to a new lifecycle status (drafting|submitted|won|lost). Submission still respects the pre-flight gate unless override is supplied.",
  signature: "update_draft_status(draft_id: string, status: string, note?: string) -> { ok }",
  exec: ({ draft_id, status, note }, { userEmail }) => {
    if (!isDraftStatus(String(status))) throw new Error(`invalid status ${status}`);
    // Submission gating — defer to /api/drafts/[id]/status for real RED-block
    // semantics. Alfred should call /api/drafts/[id]/status directly when he
    // needs the override path; this tool is the safe path for non-submitted
    // transitions.
    if (status === "submitted") {
      throw new Error("Use POST /api/drafts/[id]/status (pre-flight gated). Alfred cannot bypass pre-flight via this tool.");
    }
    const ok = setDraftStatus({ draftId: String(draft_id), userEmail, status: status as DraftStatus });
    if (!ok) throw new Error(`draft not found: ${draft_id}`);
    tryLogActivity({
      actor: userEmail,
      actionType: "draft_status_changed",
      targetType: "draft",
      targetId: String(draft_id),
      summary: `Alfred set draft → ${status}${note ? ` — ${note}` : ""}`,
    });
    return { ok: true, draft_id, status };
  },
};

const create_draft: ToolSpec = {
  name: "create_draft",
  kind: "write",
  description: "Spawn a new draft. Pre-fills empty sections; can optionally link a NOFO or pool.",
  signature: "create_draft(title: string, nofo_id?: string, pool_id?: string, partner_ids?: string[]) -> { draft_id }",
  exec: ({ title, nofo_id, pool_id, partner_ids, opportunity, business, naics }, { userEmail }) => {
    const emptyMap: SectionMap = {
      executive_summary: "",
      capability_statement: "",
      technical_approach: "",
      past_performance: "",
      reviewer_notes: "",
    };
    const meta: Record<string, unknown> = {
      createdByAlfred: true,
      partnerIds: Array.isArray(partner_ids) ? partner_ids.map(String) : [],
    };
    const saved = saveDraft({
      userEmail,
      title: String(title || "Untitled draft"),
      business: typeof business === "string" ? business : "Acme Consulting Group LLC",
      naics: typeof naics === "string" ? naics : "541611",
      opportunity: typeof opportunity === "string" ? opportunity : "",
      blocks: [],
      structured: null,
      sections: emptyMap,
      meta,
      nofoId: nofo_id ? String(nofo_id) : null,
      poolId: pool_id ? String(pool_id) : null,
    });
    tryLogActivity({
      actor: userEmail,
      actionType: "draft_created",
      targetType: "draft",
      targetId: saved.id,
      summary: `Alfred created draft: ${saved.title}`,
    });
    return { draft_id: saved.id };
  },
};

const insert_boilerplate: ToolSpec = {
  name: "insert_boilerplate",
  kind: "write",
  description: "Insert a boilerplate block into a section of a draft. Pins the inserted version.",
  signature: "insert_boilerplate(draft_id: string, block_key: string, section: string) -> { ok }",
  exec: ({ draft_id, block_key, section }, { userEmail }) => {
    const block = getBoilerplate(String(block_key));
    if (!block) throw new Error(`unknown block: ${block_key}`);
    const draft = getDraft(String(draft_id), userEmail);
    if (!draft) throw new Error(`draft not found: ${draft_id}`);
    const sectionKey = String(section) as keyof SectionMap;
    const newSections: SectionMap = { ...draft.sections };
    const existing = newSections[sectionKey] ?? "";
    newSections[sectionKey] = `${existing}${existing.trim() ? "\n\n" : ""}${block.bodyMarkdown}\n`;
    saveDraft({
      id: draft.id,
      userEmail,
      title: draft.title,
      business: draft.business,
      naics: draft.naics,
      opportunity: draft.opportunity,
      blocks: draft.blocks,
      structured: draft.structured,
      sections: newSections,
      meta: draft.meta,
      nofoId: null,
      poolId: null,
    });
    const pin = pinBoilerplateToDraft({ draftId: draft.id, blockKey: block.key, positionHint: String(section) });
    return { ok: true, draft_id, block_key, version: block.version, pin_id: pin.id };
  },
};

const run_preflight: ToolSpec = {
  name: "run_preflight",
  kind: "write",
  description: "Run the deterministic pre-submission checklist against a draft.",
  signature: "run_preflight(draft_id: string) -> PreflightResult",
  exec: ({ draft_id }, { userEmail }) => {
    const result = runPreflightById(String(draft_id), userEmail);
    if (!result) throw new Error(`draft not found: ${draft_id}`);
    tryLogActivity({
      actor: userEmail,
      actionType: "preflight_run",
      targetType: "draft",
      targetId: String(draft_id),
      summary: `Pre-flight: ${result.greenCount}G / ${result.yellowCount}Y / ${result.redCount}R`,
    });
    return result;
  },
};

const log_activity: ToolSpec = {
  name: "log_activity",
  kind: "write",
  description: "Append a free-form entry to the activity log.",
  signature: "log_activity(action_type: string, summary: string, target_type?: string, target_id?: string) -> { id }",
  exec: ({ action_type, summary, target_type, target_id }, { userEmail }) => {
    const e = logActivity({
      actor: userEmail,
      actionType: String(action_type) as ActionType,
      targetType: target_type ? String(target_type) : null,
      targetId: target_id ? String(target_id) : null,
      summary: String(summary),
    });
    return { id: e.id };
  },
};

// ---------- SCORING TOOLS ---------------------------------------------------

const adjust_scoring_weight: ToolSpec = {
  name: "adjust_scoring_weight",
  kind: "scoring",
  description: "Bump a strategic-scoring criterion weight (delta is a signed number). Persists to a small alfred_settings table.",
  signature: "adjust_scoring_weight(criterion: string, delta: number) -> { criterion, newWeight }",
  exec: ({ criterion, delta }, { userEmail }) => {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS alfred_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const key = `scoring_weight:${String(criterion)}`;
    const row = getDb()
      .prepare(`SELECT value_json FROM alfred_settings WHERE key = ?`)
      .get(key) as { value_json: string } | undefined;
    const current = row ? Number(JSON.parse(row.value_json)) : 1.0;
    const next = current + Number(delta);
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO alfred_settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(next), now);
    tryLogActivity({
      actor: userEmail,
      actionType: "alfred_tool_call",
      targetType: "scoring",
      targetId: String(criterion),
      summary: `Alfred bumped weight ${criterion}: ${current} → ${next}`,
    });
    return { criterion, oldWeight: current, newWeight: next };
  },
};

const score_item: ToolSpec = {
  name: "score_item",
  kind: "scoring",
  description:
    "Re-score a saved opportunity with the strategic 6-criteria matrix and persist the result (was a stub; wired 2026-06-09).",
  signature: "score_item(type: string, id: string) -> { ok, score, recommendation, previousScore }",
  exec: ({ type, id }, { userEmail }) => {
    const t = String(type);
    const targetId = String(id);
    // Strategic scoring is defined for saved opportunities; other types have
    // their own scorers (partner-fit, teaming-fit, underspend) with their own
    // triggers. Fail loudly instead of pretending to queue work.
    if (t !== "opportunity" && t !== "saved_opportunity") {
      throw new Error(`score_item supports saved opportunities only (got type "${t}")`);
    }
    const opp = getSavedOpportunity(targetId, userEmail);
    if (!opp) throw new Error(`opportunity not found: ${targetId}`);

    const result = computeStrategicScore({
      title: opp.title,
      agency: opp.agency,
      deadline: opp.deadline,
      eligibility: opp.eligibility,
      summary: opp.summary,
      naics: opp.naics,
    });
    const detail: Record<string, unknown> = {
      recommendation: result.recommendation,
      criteria: result.criteria,
      summary: result.summary,
    };
    const updated = setOpportunityStrategicScore(targetId, userEmail, result.score, detail);
    if (!updated) throw new Error(`failed to persist score for ${targetId}`);

    tryLogActivity({
      actor: userEmail,
      actionType: "alfred_tool_call",
      targetType: "opportunity",
      targetId,
      summary: `Alfred re-scored "${opp.title.slice(0, 60)}": ${opp.strategicScore ?? "—"} → ${result.score} (${result.recommendation})`,
    });
    return {
      ok: true,
      score: result.score,
      recommendation: result.recommendation,
      previousScore: opp.strategicScore,
    };
  },
};

// ---------- REGISTRY --------------------------------------------------------

export const ALFRED_TOOLS: ToolSpec[] = [
  // read
  read_pane_state,
  read_activity,
  read_decisions,
  read_partners,
  search_scouts,
  // view
  filter_scouts,
  pin_item,
  unpin_item,
  hide_source,
  show_source,
  highlight_item,
  set_priority,
  navigate,
  // write
  add_suggestion,
  add_decision,
  update_pool_status,
  update_draft_status,
  create_draft,
  insert_boilerplate,
  run_preflight,
  log_activity,
  // scoring
  adjust_scoring_weight,
  score_item,
];

export function getToolSpec(name: string): ToolSpec | null {
  return ALFRED_TOOLS.find((t) => t.name === name) ?? null;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { userEmail: string },
): Promise<ToolCallRecord> {
  const tool = getToolSpec(name);
  const id = randomUUID();
  const ranAtMs = Date.now();
  if (!tool) {
    return { id, toolName: name, args, result: null, error: `unknown_tool: ${name}`, ranAtMs };
  }
  try {
    const result = await tool.exec(args, ctx);
    return { id, toolName: name, args, result, error: null, ranAtMs };
  } catch (err) {
    return { id, toolName: name, args, result: null, error: err instanceof Error ? err.message : String(err), ranAtMs };
  }
}

// Renders the tool catalogue into Alfred's system prompt.
export function renderToolDocs(): string {
  const byKind: Record<ToolKind, string[]> = { read: [], view: [], write: [], scoring: [] };
  for (const t of ALFRED_TOOLS) {
    byKind[t.kind].push(`- \`${t.signature}\` — ${t.description}`);
  }
  return `## TOOLS AVAILABLE (use them — they are real, server-executed)

These are NOT external SaaS tools. They are GovScout's own server-side
functions, registered in lib/alfred-tools.ts and exposed via /api/alfred/tools.
There is no Gmail / Calendar / Slack / Stripe / etc in this Alfred surface.

To invoke a tool, emit a single self-closing marker in your reply:

  <tool_call name="<tool>" args={<JSON object>} />

Both args="..." (string form, escape the inner JSON) and args={...} (bare
JSON-object form, no quotes around the object) are accepted by the parser.
The bare form is easier to read; prefer it.

The server will execute the tool, log the result to the activity log, and
broadcast a mutation event to all panes. Multiple tool calls per turn are
fine — emit them one per line, no code fences.

Examples:

  <tool_call name="read_activity" args={"since_hours":24} />
  <tool_call name="add_decision" args={"question":"Lead with Riverside clinical or Atlas Insights technical?","options":["Riverside clinical","Atlas Insights technical","Split 50/50"],"recommended":"Riverside clinical","context_type":"draft","context_id":"abc12345"} />
  <tool_call name="pin_item" args={"type":"draft","id":"abc12345"} />

Speak to the operator normally around the markers; the markers themselves are
hidden from the chat history but the action chips render visibly.

### Read tools (no side-effects)
${byKind.read.join("\n")}

### View / filter tools (UI state only)
${byKind.view.join("\n")}

### Write tools (mutate persistent state — use deliberately)
${byKind.write.join("\n")}

### Scoring tools
${byKind.scoring.join("\n")}`;
}

// Parse `<tool_call name="..." args=... />` markers out of an assistant reply.
// Accepts two arg encodings:
//   - args="<JSON>" or args='<JSON>' or args=`<JSON>` (string-quoted)
//   - args={<JSON-object>}                            (bare JSON object — Claude's natural form)
// Returns the list of calls and the text with the markers stripped.
export function parseToolCalls(text: string): {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  stripped: string;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  // Quoted form: args='...' or args="..." or args=`...`
  const quotedRe = /<tool_call\s+name=["']([a-z_][a-z0-9_]*)["']\s+args=(['"`])([\s\S]*?)\2\s*\/>/gi;
  // Bare-object form: args={ ... }  (balanced braces, greedy but stops at " />")
  const bareRe = /<tool_call\s+name=["']([a-z_][a-z0-9_]*)["']\s+args=(\{[\s\S]*?\})\s*\/>/gi;

  const tryParse = (raw: string): Record<string, unknown> => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      try {
        return JSON.parse(raw.replace(/'/g, '"')) as Record<string, unknown>;
      } catch {
        return { _parse_error: raw };
      }
    }
  };

  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(text)) !== null) {
    calls.push({ name: m[1], args: tryParse(m[3]) });
  }
  while ((m = bareRe.exec(text)) !== null) {
    // Skip cases already matched by quoted regex (which uses different group layout).
    // Heuristic: re-check name occurrence count; cheap enough.
    calls.push({ name: m[1], args: tryParse(m[2]) });
  }

  // De-dupe identical calls (in case both regexes matched the same span).
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    const key = `${c.name}|${JSON.stringify(c.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const stripped = text
    .replace(quotedRe, "")
    .replace(bareRe, "")
    .replace(/\n{3,}/g, "\n\n");
  return { calls: unique, stripped };
}
