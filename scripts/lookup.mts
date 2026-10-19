/**
 * Unified record status lookup — "is this actually on the record, and did we
 * already act on it?" One query across every store, one consolidated answer.
 *
 * Run: npm run lookup -- <query> [--json]
 *
 *   <query>   solicitation number, notice id, fp id, title fragment, or email
 *   --json    machine-readable LookupReport instead of human text
 *
 * STRICTLY READ-ONLY. Opens data/govscout.db with {readonly, fileMustExist} —
 * never through getDb(), which lazily applies migrations. Safe to run
 * mid-deploy and beside concurrent writers; it cannot change anything.
 *
 * Exit codes: 0 = found, 3 = explicitly not found, 1 = could not run at all
 * (e.g. database unopenable — which is "unknown", NOT "not found").
 *
 * All matching/verdict/rendering logic is pure and lives in
 * lib/record-lookup.ts; this file only reads rows and prints.
 */

import path from "path";
import { parseArgs } from "util";
import { createRequire } from "module";
import {
  buildLookupReport,
  renderLookupReport,
  type BlockLite,
  type ContactLite,
  type DecisionLite,
  type FpEventLite,
  type FpOppLite,
  type LookupStores,
  type MicroLite,
  type StoreRead,
} from "../lib/record-lookup";

const DB_PATH = path.join(process.cwd(), "data", "govscout.db");

type Stmt = { all: (...args: unknown[]) => unknown[] };
type Db = { prepare: (sql: string) => Stmt };

function safeParse<T>(s: string | null, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Per-store read with per-store failure capture: an unreadable store must be
 *  REPORTED as unreadable, never mistaken for an empty one. */
function readStore<T>(fn: () => T[]): StoreRead<T> {
  try {
    return { ok: true, rows: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function readAllStores(db: Db): LookupStores {
  return {
    fp_opportunities: readStore<FpOppLite>(() =>
      (db
        .prepare(
          `SELECT id, sol_number, notice_id, title, agency, status, nobid_reason,
                  response_deadline, price_quoted, price_basis,
                  submission_method, submission_target,
                  gmail_draft_id, gmail_sent_ids,
                  poc1_name, poc1_email, poc2_name, poc2_email,
                  flagged_at, archived_at, created_at, updated_at
             FROM fp_opportunities`,
        )
        .all() as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        solNumber: (r.sol_number as string | null) ?? null,
        noticeId: (r.notice_id as string | null) ?? null,
        title: String(r.title),
        agency: (r.agency as string | null) ?? null,
        status: String(r.status),
        nobidReason: (r.nobid_reason as string | null) ?? null,
        responseDeadline: (r.response_deadline as string | null) ?? null,
        priceQuoted: r.price_quoted == null ? null : Number(r.price_quoted),
        priceBasis: (r.price_basis as string | null) ?? null,
        submissionMethod: (r.submission_method as string | null) ?? null,
        submissionTarget: (r.submission_target as string | null) ?? null,
        gmailDraftId: (r.gmail_draft_id as string | null) ?? null,
        gmailSentIds: safeParse<string[]>(r.gmail_sent_ids as string | null, []),
        poc1Name: (r.poc1_name as string | null) ?? null,
        poc1Email: (r.poc1_email as string | null) ?? null,
        poc2Name: (r.poc2_name as string | null) ?? null,
        poc2Email: (r.poc2_email as string | null) ?? null,
        flaggedAt: r.flagged_at == null ? null : Number(r.flagged_at),
        archivedAt: r.archived_at == null ? null : Number(r.archived_at),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      })),
    ),
    fp_events: readStore<FpEventLite>(() =>
      (db.prepare(`SELECT opp_id, ts, kind, detail FROM fp_events`).all() as Record<
        string,
        unknown
      >[]).map((r) => ({
        oppId: String(r.opp_id),
        ts: Number(r.ts),
        kind: String(r.kind),
        detail: safeParse<Record<string, unknown> | null>(r.detail as string | null, null),
      })),
    ),
    micro_contracts: readStore<MicroLite>(() =>
      (db
        .prepare(
          `SELECT id, notice_id, sol_number, title, agency, disposition, description,
                  response_deadline, fp_opportunity_id, created_at, updated_at
             FROM micro_contracts`,
        )
        .all() as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        noticeId: String(r.notice_id),
        solNumber: (r.sol_number as string | null) ?? null,
        title: String(r.title),
        agency: (r.agency as string | null) ?? null,
        disposition: String(r.disposition),
        description: (r.description as string | null) ?? null,
        responseDeadline: (r.response_deadline as string | null) ?? null,
        fpOpportunityId: (r.fp_opportunity_id as string | null) ?? null,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      })),
    ),
    decision_queue: readStore<DecisionLite>(() =>
      (db
        .prepare(
          `SELECT id, question, context_type, context_id, status, decision,
                  decision_note, created_at, decided_at
             FROM decision_queue`,
        )
        .all() as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        question: String(r.question),
        contextType: (r.context_type as string | null) ?? null,
        contextId: (r.context_id as string | null) ?? null,
        status: String(r.status),
        decision: (r.decision as string | null) ?? null,
        decisionNote: (r.decision_note as string | null) ?? null,
        createdAt: Number(r.created_at),
        decidedAt: r.decided_at == null ? null : Number(r.decided_at),
      })),
    ),
    trackl_contacts: readStore<ContactLite>(() =>
      (db
        .prepare(
          `SELECT c.id, c.name, c.title, c.email, c.priority, c.source,
                  a.name AS agency_name
             FROM trackl_contacts c
             LEFT JOIN trackl_agencies a ON a.id = c.agency_id`,
        )
        .all() as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        name: (r.name as string | null) ?? null,
        title: (r.title as string | null) ?? null,
        email: String(r.email),
        priority: String(r.priority),
        source: String(r.source),
        agencyName: (r.agency_name as string | null) ?? null,
      })),
    ),
    boilerplate_blocks: readStore<BlockLite>(() =>
      (db
        .prepare(`SELECT id, key, title, version, updated_at FROM boilerplate_blocks`)
        .all() as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        key: String(r.key),
        title: String(r.title),
        version: Number(r.version),
        updatedAt: Number(r.updated_at),
      })),
    ),
  };
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const query = positionals.join(" ").trim();
  if (!query) {
    process.stderr.write(
      "usage: npm run lookup -- <sol number | notice id | fp id | title fragment | email> [--json]\n",
    );
    process.exit(1);
  }

  // READ-ONLY open, and readonly is load-bearing: this tool must be safe
  // beside concurrent writers and mid-deploy, so no getDb() (it migrates).
  const Better = createRequire(import.meta.url)("better-sqlite3");
  let db: Db;
  try {
    db = new Better(DB_PATH, { readonly: true, fileMustExist: true }) as Db;
  } catch (e) {
    // Unopenable database is "UNKNOWN", never "not found".
    process.stderr.write(
      `cannot open ${DB_PATH} read-only (${e instanceof Error ? e.message : String(e)})\n` +
        `NOTHING was searched — this is not a "not found" answer.\n`,
    );
    process.exit(1);
  }

  const report = buildLookupReport(query, readAllStores(db), Date.now());
  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderLookupReport(report));
  }
  process.exit(report.found ? 0 : 3);
}

main();
