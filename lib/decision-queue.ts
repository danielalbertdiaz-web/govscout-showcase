// Decision Queue gate for bid/no-bid and price approvals — scripts/decide.mts
// is the CLI surface.
//
// decision_queue (migration 013, lib/decisions.ts) was well-designed and then
// abandoned after seven uses: its first real test was gated on a simulator
// that produced broken output twice, the same go/no-go was re-filed three
// times, and approvals routed around it into chat. This module re-earns trust
// on exactly TWO decision types — bid/no-bid and price approval — rather than
// rebuilding anything.
//
// Design rules (each traces to a way the queue lost trust the first time):
//   1. A filed decision MUST carry a recommendation and a reason. An open
//      question makes the human do the analysis — the burden the queue exists
//      to remove (the RCORP row with recommended_option NULL was work, not
//      help).
//   2. A decision MUST link to a Bid Board opportunity (context_id = fp id),
//      so `npm run lookup` surfaces it next to the record it is about.
//   3. Answering records who and when, and writes an fp_event on the linked
//      opportunity — a decision recorded only in its own table repeats the
//      fragmentation that produced the chat workaround.
//   4. Answering EXECUTES NOTHING. No status change, no send, no pricing.
//      Alfred acts afterwards, deliberately. (lib/decisions.resolveDecision
//      fires actions inline; that is exactly the coupling this path avoids,
//      which is why answering does not reuse it.)
//   5. Idempotent and safe: re-answering is a reported no-op; filing a
//      duplicate open decision for the same context+type warns; filing on an
//      opportunity whose status is already past the decision point refuses —
//      it would have caught both duplicate submissions.
//
// Reused, not reinvented: createDecision/getDecision/listDecisions and the
// Decision type (lib/decisions.ts), findFpOpportunity's id→notice→sol ladder
// and logFpEvent (lib/federal-pipeline.ts). Rendering/ordering/validation here
// is PURE — the CLI's read-only path feeds rows in without opening getDb().

import {
  createDecision,
  getDecision,
  listDecisions,
  type Decision,
} from "./decisions";
import { getDb } from "./db";
import { findFpOpportunity, logFpEvent } from "./federal-pipeline";
import type { FpEvent, FpStatus } from "./federal-pipeline-types";
import { tryLogActivity } from "./activity";

export type { Decision } from "./decisions";

// --- Types & constants -------------------------------------------------------

export const GATE_DECISION_TYPES = ["bid", "price"] as const;
export type GateDecisionType = (typeof GATE_DECISION_TYPES)[number];

export function isGateDecisionType(t: string): t is GateDecisionType {
  return (GATE_DECISION_TYPES as readonly string[]).includes(t);
}

// context_type encodes the gate type (the schema has no type column and this
// deliberately avoids a migration). Legacy rows keep pool/draft/panel_sim/...
export const GATE_CONTEXT_TYPES: Record<GateDecisionType, string> = {
  bid: "fp_bid",
  price: "fp_price",
};

/** All seven existing rows use this user_email; the CLI default matches. */
export const DEFAULT_DECISION_USER = "hello@govscout.ai";

/**
 * Statuses past the point where a bid/no-bid or price call still exists to be
 * made. Filing a gate decision on such a row is refused — a fresh go/no-go on
 * an already-submitted solicitation is how both duplicate submissions started.
 * (triaged_nobid is NOT here: reconsidering a no-bid is a legitimate new
 * decision.)
 */
export const FP_GATE_CLOSED_STATUSES: readonly FpStatus[] = [
  "submitted",
  "closed_won",
  "closed_lost",
  "closed_no_award",
  "withdrawn",
];

// --- Pure: validation --------------------------------------------------------

export type GateFilingInput = {
  type: string;
  question: string;
  options: string[];
  recommendedOption: string;
  recommendedReason: string;
  deadlineMs?: number | null;
};

/** Returns problems; empty array = valid. Pure so tests cover it directly. */
export function validateGateFiling(input: GateFilingInput): string[] {
  const problems: string[] = [];
  if (!isGateDecisionType(input.type)) {
    problems.push(`--type must be one of: ${GATE_DECISION_TYPES.join("|")}`);
  }
  if (!input.question?.trim()) problems.push("--question is required");
  const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) problems.push('--options needs at least two (e.g. "GO|NO-GO")');
  if (!input.recommendedOption?.trim()) {
    problems.push(
      "--recommend is required — a queue that asks open questions makes the human do the analysis",
    );
  }
  if (!input.recommendedReason?.trim()) {
    problems.push("--reason is required — a recommendation without its why cannot be trusted");
  }
  if (
    input.recommendedOption?.trim() &&
    options.length >= 2 &&
    !resolveOption(options, input.recommendedOption)
  ) {
    problems.push(
      `--recommend "${input.recommendedOption}" is not one of the options (${options.join(" | ")})`,
    );
  }
  if (input.deadlineMs != null && !Number.isFinite(input.deadlineMs)) {
    problems.push("--deadline did not parse to a valid time");
  }
  return problems;
}

/** Case-insensitive option match → the canonical spelling, or null. */
export function resolveOption(options: string[], answer: string): string | null {
  const want = answer.trim().toLowerCase();
  return options.find((o) => o.trim().toLowerCase() === want) ?? null;
}

// --- Pure: ordering & deadline rendering -------------------------------------

/** Most urgent first: soonest deadline (overdue sorts before everything), no
 *  deadline last; ties break oldest-filed-first. */
export function urgencyCompare(a: Decision, b: Decision): number {
  const ad = a.deadlineMs ?? Number.POSITIVE_INFINITY;
  const bd = b.deadlineMs ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.createdAt - b.createdAt;
}

export function sortByUrgency(rows: Decision[]): Decision[] {
  return [...rows].sort(urgencyCompare);
}

function fmtDur(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

/**
 * Deadline badge for list/show. An approaching (<48h) or passed deadline is
 * prefixed "!!" and shouts — impossible to miss when skimming.
 */
export function deadlineLabel(deadlineMs: number | null, now: number): string {
  if (deadlineMs == null) return "no deadline";
  const diff = deadlineMs - now;
  if (diff <= 0) return `!! OVERDUE by ${fmtDur(-diff)} (was ${fmtDate(deadlineMs)})`;
  if (diff < 48 * 3_600_000) return `!! DUE in ${fmtDur(diff)} (${fmtDate(deadlineMs)})`;
  return `due ${fmtDate(deadlineMs)} (in ${fmtDur(diff)})`;
}

// --- Pure: row mapping & rendering -------------------------------------------

function safeParse<T>(s: string | null, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Map a raw decision_queue SQL row → Decision. The CLI's read-only path opens
 * the DB directly (like scripts/lookup.mts, never via getDb() which migrates)
 * and cannot use lib/decisions' private mapper.
 */
export function decisionFromSqlRow(r: Record<string, unknown>): Decision {
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    userEmail: String(r.user_email ?? ""),
    question: String(r.question),
    contextType: (r.context_type as string | null) ?? null,
    contextId: (r.context_id as string | null) ?? null,
    options: safeParse<string[]>(r.options_json as string | null, []),
    recommendedOption: (r.recommended_option as string | null) ?? null,
    recommendedReason: (r.recommended_reason as string | null) ?? null,
    deadlineMs: r.deadline_ms == null ? null : Number(r.deadline_ms),
    status: (r.status as Decision["status"]) ?? "open",
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    decision: (r.decision as string | null) ?? null,
    decisionNote: (r.decision_note as string | null) ?? null,
    actionKind: (r.action_kind as Decision["actionKind"]) ?? null,
    actionPayload: safeParse<Record<string, unknown> | null>(
      r.action_payload as string | null,
      null,
    ),
    actionStatus: (r.action_status as Decision["actionStatus"]) ?? null,
  };
}

/** "fp_bid" → "bid", "fp_price" → "price", legacy values verbatim. */
export function gateTypeLabel(contextType: string | null): string {
  if (contextType === GATE_CONTEXT_TYPES.bid) return "bid";
  if (contextType === GATE_CONTEXT_TYPES.price) return "price";
  return contextType ?? "—";
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/** Optional context_id → human label ("HT0038… — DHA dental wax [submitted]"). */
export type ContextLabels = Record<string, string>;

function renderOne(d: Decision, now: number, labels: ContextLabels): string {
  const lines: string[] = [];
  const head =
    d.status === "open"
      ? deadlineLabel(d.deadlineMs, now)
      : `${d.status}${d.decision ? ` → ${trunc(d.decision, 40)}` : ""}${d.decidedAt ? ` (${fmtDate(d.decidedAt)})` : ""}`;
  lines.push(`${d.id.slice(0, 8)}  [${gateTypeLabel(d.contextType)}]  ${head}`);
  if (d.contextId) {
    lines.push(`    on: ${labels[d.contextId] ?? d.contextId}`);
  }
  lines.push(`    Q: ${trunc(d.question, 160)}`);
  lines.push(
    d.recommendedOption
      ? `    → recommend ${d.recommendedOption}${d.recommendedReason ? ` — ${trunc(d.recommendedReason, 160)}` : " (no reason recorded)"}`
      : `    → NO RECOMMENDATION recorded${d.recommendedReason ? ` — ${trunc(d.recommendedReason, 120)}` : ""} (legacy row; new filings require one)`,
  );
  if (d.status !== "open" && d.decisionNote) lines.push(`    note: ${trunc(d.decisionNote, 160)}`);
  return lines.join("\n");
}

export function renderDecisionList(
  rows: Decision[],
  now: number,
  opts?: { all?: boolean; contextLabels?: ContextLabels },
): string {
  const labels = opts?.contextLabels ?? {};
  const open = sortByUrgency(rows.filter((d) => d.status === "open"));
  const out: string[] = [];
  out.push(`OPEN DECISIONS (${open.length})`);
  if (open.length === 0) out.push("  none — nothing is waiting on a human call");
  for (const d of open) out.push("", renderOne(d, now, labels));
  if (opts?.all) {
    const rest = rows
      .filter((d) => d.status !== "open")
      .sort((a, b) => b.createdAt - a.createdAt);
    out.push("", `RESOLVED / DISMISSED (${rest.length})`);
    for (const d of rest) out.push("", renderOne(d, now, labels));
  }
  const openWithDeadline = open.filter((d) => d.deadlineMs != null && d.deadlineMs - now < 48 * 3_600_000);
  if (openWithDeadline.length > 0) {
    out.push(
      "",
      `!! ${openWithDeadline.length} open decision${openWithDeadline.length === 1 ? "" : "s"} overdue or due within 48h — see above`,
    );
  }
  return out.join("\n") + "\n";
}

export function renderDecisionShow(
  d: Decision,
  now: number,
  contextLabel?: string | null,
): string {
  const lines: string[] = [];
  lines.push(`decision ${d.id}`);
  lines.push(`  type:      ${gateTypeLabel(d.contextType)}`);
  lines.push(`  status:    ${d.status}`);
  lines.push(`  filed:     ${fmtDate(d.createdAt)} by ${d.userEmail || "—"}`);
  lines.push(`  deadline:  ${deadlineLabel(d.deadlineMs, now)}`);
  lines.push(`  context:   ${contextLabel ?? d.contextId ?? "— (not linked)"}`);
  lines.push(`  question:  ${d.question}`);
  lines.push(`  options:`);
  for (const o of d.options) {
    lines.push(`    ${o === d.recommendedOption ? "→" : " "} ${o}`);
  }
  lines.push(
    d.recommendedReason
      ? `  reason:    ${d.recommendedReason}`
      : `  reason:    — (none recorded; new filings require one)`,
  );
  if (d.status !== "open") {
    lines.push(`  decision:  ${d.decision ?? "—"}${d.decidedAt ? ` at ${fmtDate(d.decidedAt)}` : ""}`);
    if (d.decisionNote) lines.push(`  note:      ${d.decisionNote}`);
  }
  if (d.actionKind && d.actionKind !== "none") {
    lines.push(
      `  action:    ${d.actionKind} [${d.actionStatus ?? "—"}] — recorded only; this tool never executes it`,
    );
  }
  return lines.join("\n") + "\n";
}

// --- DB: filing --------------------------------------------------------------

export type FileGateResult = {
  decision: Decision;
  opportunity: { id: string; solNumber: string | null; title: string; status: string };
  warnings: string[];
};

export function fileGateDecision(input: {
  type: GateDecisionType;
  /** fp id, notice id, or sol number — the findFpOpportunity ladder. */
  contextHandle: string;
  question: string;
  options: string[];
  recommendedOption: string;
  recommendedReason: string;
  deadlineMs?: number | null;
  userEmail?: string;
}): FileGateResult {
  const problems = validateGateFiling(input);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const opp = findFpOpportunity(input.contextHandle);
  if (!opp) {
    throw new Error(
      `no opportunity matches: ${input.contextHandle} — a gate decision must link to a Bid Board row (npm run lookup to check what exists)`,
    );
  }
  if ((FP_GATE_CLOSED_STATUSES as readonly string[]).includes(opp.status)) {
    throw new Error(
      `refusing to file: ${opp.solNumber ?? opp.id} is already "${opp.status}" — the ${input.type} call has been made. ` +
        `Re-filing a decided question is how duplicate submissions started; if this is a deliberate reopen, change the opportunity status first (fp set-status).`,
    );
  }

  const contextType = GATE_CONTEXT_TYPES[input.type];
  const warnings: string[] = [];
  const dup = listDecisions({ status: "open" }).filter(
    (d) => d.contextId === opp.id && d.contextType === contextType,
  );
  if (dup.length > 0) {
    warnings.push(
      `WARNING: ${dup.length} open ${input.type} decision${dup.length === 1 ? "" : "s"} already filed for this opportunity (${dup
        .map((d) => d.id.slice(0, 8))
        .join(", ")}) — answer or dismiss those instead of stacking duplicates`,
    );
  }

  const options = input.options.map((o) => o.trim()).filter(Boolean);
  const decision = createDecision({
    userEmail: input.userEmail?.trim() || DEFAULT_DECISION_USER,
    question: input.question,
    contextType,
    contextId: opp.id,
    options,
    // canonical spelling from the options list, so answer matching is exact
    recommendedOption: resolveOption(options, input.recommendedOption),
    recommendedReason: input.recommendedReason.trim(),
    deadlineMs: input.deadlineMs ?? null,
    actionKind: "none",
  });
  return {
    decision,
    opportunity: { id: opp.id, solNumber: opp.solNumber, title: opp.title, status: opp.status },
    warnings,
  };
}

// --- DB: answering -----------------------------------------------------------

/** Exact id, else unique id prefix (uuids are unkind to typists). */
export function findGateDecision(handle: string): Decision | null {
  const exact = getDecision(handle);
  if (exact) return exact;
  const rows = getDb()
    .prepare(`SELECT id FROM decision_queue WHERE id LIKE ?`)
    .all(handle + "%") as Array<{ id: string }>;
  if (rows.length > 1) {
    throw new Error(`ambiguous id prefix "${handle}" — ${rows.length} decisions match`);
  }
  return rows.length === 1 ? getDecision(rows[0].id) : null;
}

export type AnswerGateResult = {
  /** false = reported no-op (already answered); nothing was written. */
  changed: boolean;
  decision: Decision;
  /** fp_event written on the linked opportunity, or null (see warnings). */
  event: FpEvent | null;
  warnings: string[];
};

/**
 * Record a human decision. Writes the decision row + an fp_event on the linked
 * opportunity, and NOTHING else — no status change, no send, no action firing.
 */
export function answerGateDecision(input: {
  id: string;
  decision: string;
  by: string;
  note?: string | null;
}): AnswerGateResult {
  const by = input.by?.trim();
  if (!by) throw new Error("--by is required — a decision must record who made it");
  const existing = findGateDecision(input.id);
  if (!existing) throw new Error(`no decision matches: ${input.id}`);

  if (existing.status !== "open") {
    // Reported no-op, never a silent overwrite — the first decision stands.
    return {
      changed: false,
      decision: existing,
      event: null,
      warnings: [
        `already ${existing.status}${existing.decision ? ` → "${existing.decision}"` : ""}${
          existing.decidedAt ? ` at ${fmtDate(existing.decidedAt)}` : ""
        } — nothing written. File a new decision if circumstances changed.`,
      ],
    };
  }

  const canonical = resolveOption(existing.options, input.decision);
  if (!canonical) {
    throw new Error(
      `"${input.decision}" is not one of this decision's options: ${existing.options.join(" | ")}`,
    );
  }

  const now = Date.now();
  const note = input.note?.trim() || null;
  // who is recorded in the row itself (schema has no decided_by column and
  // this deliberately avoids a migration), and again in the fp_event detail.
  const decisionNote = note ? `${note} — by ${by}` : `by ${by}`;
  getDb()
    .prepare(
      `UPDATE decision_queue
         SET status = 'decided', updated_at = ?, decided_at = ?, decision = ?, decision_note = ?
       WHERE id = ?`,
    )
    .run(now, now, canonical, decisionNote, existing.id);

  const warnings: string[] = [];
  let event: FpEvent | null = null;
  const opp = existing.contextId ? findFpOpportunity(existing.contextId) : null;
  if (opp) {
    event = logFpEvent(opp.id, "note", {
      via: "decision_queue",
      decisionId: existing.id,
      decisionType: gateTypeLabel(existing.contextType),
      question: trunc(existing.question, 200),
      decision: canonical,
      by,
      ...(note ? { note } : {}),
    });
  } else {
    warnings.push(
      "decision recorded, but its context is not a Bid Board opportunity — no fp_event written",
    );
  }
  if (existing.actionKind && existing.actionKind !== "none") {
    warnings.push(
      `action "${existing.actionKind}" was NOT executed (status stays ${existing.actionStatus ?? "pending"}) — recording a decision never fires side-effects; Alfred acts separately`,
    );
  }
  tryLogActivity({
    actor: by,
    actionType: "decision_resolved",
    targetType: "decision",
    targetId: existing.id,
    summary: `Decision answered → ${canonical}${note ? ` (${trunc(note, 80)})` : ""}`,
  });
  return { changed: true, decision: findGateDecision(existing.id) as Decision, event, warnings };
}
