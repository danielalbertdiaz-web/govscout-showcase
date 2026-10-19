/**
 * Decision Queue CLI — bid/no-bid and price-approval gates on the Bid Board.
 * Records human decisions; NEVER executes them (no sends, no pricing, no
 * status changes — Alfred acts afterwards, deliberately).
 *
 * Run: npm run decide -- <command> [args]
 *
 *   list [--all] [--json]           open decisions, most urgent first
 *                                   (--all also shows resolved/dismissed)
 *   show <id|prefix> [--json]       one decision in full
 *   file --type bid|price --context <id|sol|notice> --question "..."
 *        --options "GO|NO-GO" --recommend GO --reason "..."
 *        [--deadline <iso>] [--user <email>]
 *   answer <id|prefix> --decision <option> --by <who> [--note "..."]
 *
 * Conventions follow scripts/fp.mts (mutations: JSON out, non-zero exit on bad
 * input) and scripts/lookup.mts (reads: human text with --json escape hatch,
 * and STRICTLY READ-ONLY — list/show open the DB {readonly, fileMustExist},
 * never through getDb(), so they are safe beside concurrent writers).
 */

import path from "path";
import { parseArgs } from "util";
import { createRequire } from "module";
import {
  decisionFromSqlRow,
  renderDecisionList,
  renderDecisionShow,
  sortByUrgency,
  isGateDecisionType,
  fileGateDecision,
  answerGateDecision,
  GATE_DECISION_TYPES,
  type ContextLabels,
  type Decision,
} from "../lib/decision-queue";

const DB_PATH = path.join(process.cwd(), "data", "govscout.db");

function ok(payload: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + "\n");
  process.exit(0);
}

function fail(error: string, extra: Record<string, unknown> = {}): never {
  process.stderr.write(JSON.stringify({ ok: false, error, ...extra }) + "\n");
  process.exit(1);
}

// --- read-only path (list / show) --------------------------------------------

type Stmt = { all: (...args: unknown[]) => unknown[] };
type Db = { prepare: (sql: string) => Stmt };

function openReadOnly(): Db {
  const Better = createRequire(import.meta.url)("better-sqlite3");
  try {
    return new Better(DB_PATH, { readonly: true, fileMustExist: true }) as Db;
  } catch (e) {
    fail(
      `cannot open ${DB_PATH} read-only (${e instanceof Error ? e.message : String(e)}) — nothing was searched`,
    );
  }
}

function readDecisions(db: Db): Decision[] {
  return (db.prepare(`SELECT * FROM decision_queue`).all() as Record<string, unknown>[]).map(
    decisionFromSqlRow,
  );
}

/** context_id → "sol — title [status]" for every linked fp opportunity. */
function readContextLabels(db: Db, rows: Decision[]): ContextLabels {
  const ids = [...new Set(rows.map((d) => d.contextId).filter((v): v is string => v != null))];
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => "?").join(",");
  const opps = db
    .prepare(
      `SELECT id, sol_number, title, status FROM fp_opportunities WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{ id: string; sol_number: string | null; title: string; status: string }>;
  const labels: ContextLabels = {};
  for (const o of opps) {
    labels[o.id] = `${o.sol_number ?? o.id} — ${o.title} [${o.status}]`;
  }
  return labels;
}

function cmdList(values: { all?: boolean; json?: boolean }) {
  const db = openReadOnly();
  const rows = readDecisions(db);
  if (values.json) {
    const open = sortByUrgency(rows.filter((d) => d.status === "open"));
    const rest = rows.filter((d) => d.status !== "open").sort((a, b) => b.createdAt - a.createdAt);
    ok({ open, ...(values.all ? { resolved: rest } : {}) });
  }
  process.stdout.write(
    renderDecisionList(rows, Date.now(), {
      all: values.all,
      contextLabels: readContextLabels(db, rows),
    }),
  );
  process.exit(0);
}

function cmdShow(positionals: string[], values: { json?: boolean }) {
  const [handle] = positionals;
  if (!handle) fail("usage: decide show <id|prefix> [--json]");
  const db = openReadOnly();
  const rows = readDecisions(db);
  const matches = rows.filter((d) => d.id === handle || d.id.startsWith(handle));
  if (matches.length === 0) fail(`no decision matches: ${handle}`);
  if (matches.length > 1) {
    fail(`ambiguous id prefix "${handle}"`, { matches: matches.map((d) => d.id) });
  }
  const d = matches[0];
  if (values.json) ok({ decision: d });
  const labels = readContextLabels(db, [d]);
  process.stdout.write(
    renderDecisionShow(d, Date.now(), d.contextId ? (labels[d.contextId] ?? null) : null),
  );
  process.exit(0);
}

// --- write path (file / answer) — goes through lib (getDb) -------------------

function parseDeadline(v: string | undefined): number | null {
  if (!v) return null;
  // date-only means "end of that day UTC" — a deadline, not a start time
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T23:59:59Z` : v.trim();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) fail(`invalid --deadline: ${v} (expected ISO date/datetime)`);
  return ms;
}

function cmdFile(values: {
  type?: string;
  context?: string;
  question?: string;
  options?: string;
  recommend?: string;
  reason?: string;
  deadline?: string;
  user?: string;
}) {
  const usage =
    'usage: decide file --type bid|price --context <id|sol|notice> --question "..." --options "GO|NO-GO" --recommend GO --reason "..." [--deadline <iso>] [--user <email>]';
  if (!values.type || !isGateDecisionType(values.type)) {
    fail(`--type must be one of: ${GATE_DECISION_TYPES.join("|")}`, { usage });
  }
  if (!values.context) fail("--context is required (fp id, sol number, or notice id)", { usage });
  if (!values.question) fail("--question is required", { usage });
  if (!values.options) fail('--options is required (pipe-separated, e.g. "GO|NO-GO")', { usage });
  if (!values.recommend) {
    fail("--recommend is required — a filed decision must carry a recommendation", { usage });
  }
  if (!values.reason) {
    fail("--reason is required — a recommendation without its why cannot be trusted", { usage });
  }
  try {
    const result = fileGateDecision({
      type: values.type,
      contextHandle: values.context,
      question: values.question,
      options: values.options.split("|"),
      recommendedOption: values.recommend,
      recommendedReason: values.reason,
      deadlineMs: parseDeadline(values.deadline),
      userEmail: values.user,
    });
    ok({
      decision: result.decision,
      opportunity: result.opportunity,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function cmdAnswer(
  positionals: string[],
  values: { decision?: string; by?: string; note?: string },
) {
  const [handle] = positionals;
  const usage = 'usage: decide answer <id|prefix> --decision <option> --by <who> [--note "..."]';
  if (!handle) fail(usage);
  if (!values.decision) fail("--decision is required", { usage });
  if (!values.by) fail("--by is required — a decision must record who made it", { usage });
  try {
    const result = answerGateDecision({
      id: handle,
      decision: values.decision,
      by: values.by,
      note: values.note ?? null,
    });
    ok({
      changed: result.changed,
      decision: result.decision,
      event: result.event,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) fail("usage: decide <list|show|file|answer>");
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      type: { type: "string" },
      context: { type: "string" },
      question: { type: "string" },
      options: { type: "string" },
      recommend: { type: "string" },
      reason: { type: "string" },
      deadline: { type: "string" },
      user: { type: "string" },
      decision: { type: "string" },
      by: { type: "string" },
      note: { type: "string" },
    },
  });

  switch (cmd) {
    case "list":
      return cmdList(values);
    case "show":
      return cmdShow(positionals, values);
    case "file":
      return cmdFile(values);
    case "answer":
      return cmdAnswer(positionals, values);
    default:
      fail(`unknown command: ${cmd}`);
  }
}

try {
  main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
