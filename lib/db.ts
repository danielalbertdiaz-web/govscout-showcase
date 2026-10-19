import path from "path";
import fs from "fs";
import { emptySections, joinSections, type SectionMap, type SectionKey } from "./sections";
import { isSetAsideCanonical, normaliseSetAside, type SetAsideCanonical } from "./set-aside";
import { resolveLink, type IdentityRow } from "./opportunity-identity";
import type { ExtractedNofo } from "./extract";
import {
  isDisposition,
  dollarBand,
  parseDollarAmount,
  type Disposition,
  type OppDimensions,
  type DispositionRecord,
} from "./disposition";
import {
  POOL_STATUSES,
  isPoolStatus,
  type FundingPool,
  type PoolStatus,
} from "./pools-types";
import {
  readDraftRoster,
  writeRosterToMeta,
  includedPartnerIds,
  type DraftPartnerEntry,
} from "./draft-partners";
import {
  isOutreachStatus,
  DEFAULT_OUTREACH_STATUS,
  type OutreachStatus,
} from "./contact-outreach";
import {
  isNonprofitDisposition,
  type NonprofitDisposition,
} from "./nonprofit-scanner";
import {
  isTeamingDisposition,
  type TeamingDisposition,
} from "./teaming-sources/types";
import { assertTransition, isDraftStatus, type DraftStatus } from "./draft-state";
import {
  isMicroContractDisposition,
  MICRO_CONTRACT_DISPOSITIONS,
  MICRO_CONTRACT_DISPOSITION_LABELS,
  type MicroContractDisposition,
} from "./micro-contracts-types";

export { POOL_STATUSES, isPoolStatus, type FundingPool, type PoolStatus };
export {
  isMicroContractDisposition,
  MICRO_CONTRACT_DISPOSITIONS,
  MICRO_CONTRACT_DISPOSITION_LABELS,
  type MicroContractDisposition,
};

// Driver router: prod uses libsql/Turso (DATABASE_URL=libsql://...turso.io with
// DATABASE_AUTH_TOKEN), local dev defaults to better-sqlite3 on disk. The
// libsql npm package is API-compatible with better-sqlite3 so the rest of this
// file is unchanged regardless of driver.
// Per pivot 2026-06-03 (C1): personal-tool deploy uses better-sqlite3 only; the
// libsql branch is kept as defensive code but DATABASE_URL is expected unset.
type AnyDb = {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
  };
  exec: (sql: string) => unknown;
  pragma: (s: string) => unknown;
};

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "govscout.db");
const MIGRATIONS_DIR = path.join(process.cwd(), "lib", "migrations");
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const USE_LIBSQL = Boolean(
  DATABASE_URL &&
    (DATABASE_URL.startsWith("libsql:") ||
      DATABASE_URL.startsWith("https:") ||
      DATABASE_URL.startsWith("wss:") ||
      DATABASE_URL === "file:libsql"),
);

let dbInstance: AnyDb | null = null;

/**
 * Test-mode guard.
 *
 * DB_PATH is derived from process.cwd(), and isolation is per-file convention:
 * a test chdir()s to a mkdtemp directory before importing anything that
 * reaches this module. Most test files never touch the database, so they skip
 * the ritual — which means the only thing standing between `npm test` and the
 * production database is that no unisolated test happens to call getDb().
 *
 * That held by luck, not design, and scripts/deploy.sh now runs the suite from
 * the repo root on every deploy. So: when the runner marks the process as a
 * test run, refuse to open a database inside the repository. Unisolated tests
 * fail loudly on first use instead of quietly migrating and writing real data.
 */
function assertNotProductionDbInTests(resolved: string): void {
  if (process.env.GOVSCOUT_TEST !== "1") return;
  const root = process.env.GOVSCOUT_REPO_ROOT;
  if (!root) return;
  const repoRoot = path.resolve(root);
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `Refusing to open the production database from a test run.\n` +
        `  resolved: ${resolved}\n` +
        `  repo:     ${repoRoot}\n` +
        `This test reached getDb() without isolating itself. chdir() to a temp ` +
        `directory (with lib/migrations symlinked) BEFORE importing the module ` +
        `under test — see tests/federal-pipeline.test.ts for the pattern.`,
    );
  }
}

export function getDb(): AnyDb {
  if (dbInstance) return dbInstance;
  let db: AnyDb;
  if (USE_LIBSQL) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const Libsql = require("libsql");
    db = new Libsql(DATABASE_URL, {
      authToken: process.env.DATABASE_AUTH_TOKEN ?? undefined,
    }) as AnyDb;
    db.pragma("foreign_keys = ON");
  } else {
    assertNotProductionDbInTests(DB_PATH);
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    /* eslint-disable @typescript-eslint/no-require-imports */
    const Better = require("better-sqlite3");
    db = new Better(DB_PATH) as AnyDb;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  // Baseline tables that predate the migration runner. Idempotent — the
  // migration runner will re-issue these via 001_drafts_v1.sql but
  // CREATE TABLE IF NOT EXISTS keeps both paths safe.
  db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      title TEXT NOT NULL,
      business TEXT NOT NULL,
      naics TEXT NOT NULL,
      opportunity TEXT NOT NULL,
      blocks_json TEXT NOT NULL,
      structured_json TEXT,
      sections_json TEXT NOT NULL,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_email);

    CREATE TABLE IF NOT EXISTS draft_versions (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      section TEXT,
      instruction TEXT,
      text TEXT NOT NULL,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_versions_draft ON draft_versions(draft_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS saved_opportunities (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      agency TEXT,
      deadline TEXT,
      funding_floor TEXT,
      funding_ceiling TEXT,
      eligibility TEXT,
      url TEXT,
      nofo_url TEXT,
      summary TEXT,
      naics TEXT,
      raw_json TEXT,
      notes TEXT,
      UNIQUE(user_email, source, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_opportunities(user_email, created_at DESC);
  `);
  runMigrations(db);
  dbInstance = db;
  return db;
}

function runMigrations(db: AnyDb) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  // Use prepare/get instead of pragma() so libsql and better-sqlite3 behave
  // the same way.
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0) || 0;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (!Number.isFinite(version) || version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type DraftRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  userEmail: string;
  title: string;
  business: string;
  naics: string;
  opportunity: string;
  blocks: string[];
  structured: ExtractedNofo | null;
  sections: SectionMap;
  meta: Record<string, unknown> | null;
  nofoId: string | null;
  poolId: string | null;
};

export type DraftVersion = {
  id: string;
  draftId: string;
  createdAt: number;
  kind: "full" | "section";
  section: SectionKey | null;
  instruction: string | null;
  text: string;
  meta: Record<string, unknown> | null;
};

type DraftRow = {
  id: string;
  created_at: number;
  updated_at: number;
  user_email: string;
  title: string;
  business: string;
  naics: string;
  opportunity: string;
  blocks_json: string;
  structured_json: string | null;
  sections_json: string;
  meta_json: string | null;
  nofo_id: string | null;
  pool_id: string | null;
};

type VersionRow = {
  id: string;
  draft_id: string;
  created_at: number;
  kind: string;
  section: string | null;
  instruction: string | null;
  text: string;
  meta_json: string | null;
};

function rowToDraft(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userEmail: row.user_email,
    title: row.title,
    business: row.business,
    naics: row.naics,
    opportunity: row.opportunity,
    blocks: safeParse<string[]>(row.blocks_json, []),
    structured: row.structured_json ? safeParse<ExtractedNofo>(row.structured_json, {}) : null,
    sections: { ...emptySections(), ...safeParse<Partial<SectionMap>>(row.sections_json, {}) },
    meta: row.meta_json ? safeParse<Record<string, unknown>>(row.meta_json, {}) : null,
    nofoId: row.nofo_id ?? null,
    poolId: row.pool_id ?? null,
  };
}

function rowToVersion(row: VersionRow): DraftVersion {
  return {
    id: row.id,
    draftId: row.draft_id,
    createdAt: row.created_at,
    kind: (row.kind === "section" ? "section" : "full"),
    section: (row.section as SectionKey | null) ?? null,
    instruction: row.instruction,
    text: row.text,
    meta: row.meta_json ? safeParse<Record<string, unknown>>(row.meta_json, {}) : null,
  };
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export type SaveDraftInput = {
  id?: string;
  userEmail: string;
  title: string;
  business: string;
  naics: string;
  opportunity: string;
  blocks: string[];
  structured: ExtractedNofo | null;
  sections: SectionMap;
  meta?: Record<string, unknown> | null;
  nofoId?: string | null;
  poolId?: string | null;
};

export function saveDraft(input: SaveDraftInput): DraftRecord {
  const db = getDb();
  const now = Date.now();
  const id = input.id ?? randomId();
  const existing = input.id ? (db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined) : undefined;
  const createdAt = existing?.created_at ?? now;
  const stmt = db.prepare(`
    INSERT INTO drafts (id, created_at, updated_at, user_email, title, business, naics, opportunity, blocks_json, structured_json, sections_json, meta_json, nofo_id, pool_id)
    VALUES (@id, @created_at, @updated_at, @user_email, @title, @business, @naics, @opportunity, @blocks_json, @structured_json, @sections_json, @meta_json, @nofo_id, @pool_id)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      title = excluded.title,
      business = excluded.business,
      naics = excluded.naics,
      opportunity = excluded.opportunity,
      blocks_json = excluded.blocks_json,
      structured_json = excluded.structured_json,
      sections_json = excluded.sections_json,
      meta_json = excluded.meta_json,
      nofo_id = excluded.nofo_id,
      pool_id = excluded.pool_id
  `);
  stmt.run({
    id,
    created_at: createdAt,
    updated_at: now,
    user_email: input.userEmail,
    title: input.title,
    business: input.business,
    naics: input.naics,
    opportunity: input.opportunity,
    blocks_json: JSON.stringify(input.blocks),
    structured_json: input.structured ? JSON.stringify(input.structured) : null,
    sections_json: JSON.stringify(input.sections),
    meta_json: input.meta ? JSON.stringify(input.meta) : null,
    nofo_id: input.nofoId ?? null,
    pool_id: input.poolId ?? null,
  });
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow;
  return rowToDraft(row);
}

export function appendVersion(input: {
  draftId: string;
  kind: "full" | "section";
  section?: SectionKey | null;
  instruction?: string | null;
  text: string;
  meta?: Record<string, unknown> | null;
}): DraftVersion {
  const db = getDb();
  const id = randomId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO draft_versions (id, draft_id, created_at, kind, section, instruction, text, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.draftId,
    now,
    input.kind,
    input.section ?? null,
    input.instruction ?? null,
    input.text,
    input.meta ? JSON.stringify(input.meta) : null,
  );
  const row = db.prepare("SELECT * FROM draft_versions WHERE id = ?").get(id) as VersionRow;
  return rowToVersion(row);
}

export function listDrafts(userEmail: string, limit = 100): DraftRecord[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM drafts WHERE user_email = ? ORDER BY updated_at DESC LIMIT ?")
    .all(userEmail, limit) as DraftRow[];
  return rows.map(rowToDraft);
}

export function getDraft(id: string, userEmail: string): DraftRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM drafts WHERE id = ? AND user_email = ?").get(id, userEmail) as DraftRow | undefined;
  return row ? rowToDraft(row) : null;
}

// Item 4.1 — read the curated per-draft partner roster (migrating legacy
// partnerLead / partnerSelection shapes lazily). Returns [] for a missing draft.
export function getDraftRoster(id: string, userEmail: string): DraftPartnerEntry[] {
  const draft = getDraft(id, userEmail);
  if (!draft) return [];
  return readDraftRoster(draft.meta);
}

// Item 4.1 — persist a curated roster into the draft's meta, preserving every
// other draft field + meta key. Returns the updated record, or null if the
// draft isn't owned by this user.
export function setDraftPartners(
  id: string,
  userEmail: string,
  roster: DraftPartnerEntry[],
): DraftRecord | null {
  const draft = getDraft(id, userEmail);
  if (!draft) return null;
  const meta = writeRosterToMeta(draft.meta, roster);
  return saveDraft({
    id: draft.id,
    userEmail,
    title: draft.title,
    business: draft.business,
    naics: draft.naics,
    opportunity: draft.opportunity,
    blocks: draft.blocks,
    structured: draft.structured,
    sections: draft.sections,
    meta,
    nofoId: draft.nofoId,
    poolId: draft.poolId,
  });
}

export function listVersions(draftId: string, userEmail: string): DraftVersion[] {
  const db = getDb();
  const owns = db.prepare("SELECT 1 FROM drafts WHERE id = ? AND user_email = ?").get(draftId, userEmail);
  if (!owns) return [];
  const rows = db
    .prepare("SELECT * FROM draft_versions WHERE draft_id = ? ORDER BY created_at ASC")
    .all(draftId) as VersionRow[];
  return rows.map(rowToVersion);
}

export function deleteDraft(id: string, userEmail: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM drafts WHERE id = ? AND user_email = ?").run(id, userEmail);
  return res.changes > 0;
}

export function draftToFullText(d: DraftRecord): string {
  return joinSections(d.sections);
}

export type SavedOpportunity = {
  id: string;
  createdAt: number;
  userEmail: string;
  source: "govscout" | "grants_gov" | "sam_gov" | "manual";
  sourceId: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  fundingFloor: string | null;
  fundingCeiling: string | null;
  eligibility: string | null;
  url: string | null;
  nofoUrl: string | null;
  summary: string | null;
  naics: string | null;
  raw: Record<string, unknown> | null;
  notes: string | null;
  // AI enhancements (migration 008) — all nullable until computed.
  strategicScore: number | null;
  strategicScoreDetail: Record<string, unknown> | null;
  strategicScoredAt: number | null;
  complianceStatus: string | null;
  complianceDetail: Record<string, unknown>[] | null;
  complianceCheckedAt: number | null;
  pipelineStage: string | null;
  pipelineUpdatedAt: number | null;
  pipelineMeta: Record<string, unknown> | null;
  // Win/loss disposition (migration 023, Item 3.1) — null until an outcome is set.
  disposition: string | null;
  dispositionNote: string | null;
  dispositionAt: number | null;
};

type SavedOppRow = {
  id: string;
  created_at: number;
  user_email: string;
  source: string;
  source_id: string;
  title: string;
  agency: string | null;
  deadline: string | null;
  funding_floor: string | null;
  funding_ceiling: string | null;
  eligibility: string | null;
  url: string | null;
  nofo_url: string | null;
  summary: string | null;
  naics: string | null;
  raw_json: string | null;
  notes: string | null;
  // AI enhancements (migration 008) — may be undefined on old rows.
  strategic_score?: number | null;
  strategic_score_detail?: string | null;
  strategic_scored_at?: number | null;
  compliance_status?: string | null;
  compliance_detail?: string | null;
  compliance_checked_at?: number | null;
  pipeline_stage?: string | null;
  pipeline_updated_at?: number | null;
  pipeline_meta?: string | null;
  // Win/loss disposition (migration 023) — may be undefined on old rows.
  disposition?: string | null;
  disposition_note?: string | null;
  disposition_at?: number | null;
};

function rowToSavedOpp(row: SavedOppRow): SavedOpportunity {
  return {
    id: row.id,
    createdAt: row.created_at,
    userEmail: row.user_email,
    source: (row.source as SavedOpportunity["source"]) ?? "manual",
    sourceId: row.source_id,
    title: row.title,
    agency: row.agency,
    deadline: row.deadline,
    fundingFloor: row.funding_floor,
    fundingCeiling: row.funding_ceiling,
    eligibility: row.eligibility,
    url: row.url,
    nofoUrl: row.nofo_url,
    summary: row.summary,
    naics: row.naics,
    raw: row.raw_json ? safeParse<Record<string, unknown>>(row.raw_json, {}) : null,
    notes: row.notes,
    strategicScore: row.strategic_score == null ? null : Number(row.strategic_score),
    strategicScoreDetail: row.strategic_score_detail
      ? safeParse<Record<string, unknown>>(row.strategic_score_detail, {})
      : null,
    strategicScoredAt: row.strategic_scored_at == null ? null : Number(row.strategic_scored_at),
    complianceStatus: row.compliance_status ?? null,
    complianceDetail: row.compliance_detail
      ? safeParse<Record<string, unknown>[]>(row.compliance_detail, [])
      : null,
    complianceCheckedAt: row.compliance_checked_at == null ? null : Number(row.compliance_checked_at),
    pipelineStage: row.pipeline_stage ?? null,
    pipelineUpdatedAt: row.pipeline_updated_at == null ? null : Number(row.pipeline_updated_at),
    pipelineMeta: row.pipeline_meta
      ? safeParse<Record<string, unknown>>(row.pipeline_meta, {})
      : null,
    disposition: row.disposition ?? null,
    dispositionNote: row.disposition_note ?? null,
    dispositionAt: row.disposition_at == null ? null : Number(row.disposition_at),
  };
}

export type SaveOpportunityInput = Omit<
  SavedOpportunity,
  | "id"
  | "createdAt"
  | "userEmail"
  | "raw"
  | "strategicScore"
  | "strategicScoreDetail"
  | "strategicScoredAt"
  | "complianceStatus"
  | "complianceDetail"
  | "complianceCheckedAt"
  | "pipelineStage"
  | "pipelineUpdatedAt"
  | "pipelineMeta"
  | "disposition"
  | "dispositionNote"
  | "dispositionAt"
> & {
  raw?: Record<string, unknown> | null;
};

export function saveOpportunity(userEmail: string, input: SaveOpportunityInput): SavedOpportunity {
  const db = getDb();
  const id = randomId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO saved_opportunities (
      id, created_at, user_email, source, source_id,
      title, agency, deadline, funding_floor, funding_ceiling,
      eligibility, url, nofo_url, summary, naics, raw_json, notes
    ) VALUES (
      @id, @created_at, @user_email, @source, @source_id,
      @title, @agency, @deadline, @funding_floor, @funding_ceiling,
      @eligibility, @url, @nofo_url, @summary, @naics, @raw_json, @notes
    )
    ON CONFLICT(user_email, source, source_id) DO UPDATE SET
      title = excluded.title,
      agency = excluded.agency,
      deadline = excluded.deadline,
      funding_floor = excluded.funding_floor,
      funding_ceiling = excluded.funding_ceiling,
      eligibility = excluded.eligibility,
      url = excluded.url,
      nofo_url = excluded.nofo_url,
      summary = excluded.summary,
      naics = excluded.naics,
      raw_json = excluded.raw_json,
      notes = excluded.notes
  `).run({
    id,
    created_at: now,
    user_email: userEmail,
    source: input.source,
    source_id: input.sourceId,
    title: input.title,
    agency: input.agency,
    deadline: input.deadline,
    funding_floor: input.fundingFloor,
    funding_ceiling: input.fundingCeiling,
    eligibility: input.eligibility,
    url: input.url,
    nofo_url: input.nofoUrl,
    summary: input.summary,
    naics: input.naics,
    raw_json: input.raw ? JSON.stringify(input.raw) : null,
    notes: input.notes,
  });
  const row = db
    .prepare("SELECT * FROM saved_opportunities WHERE user_email = ? AND source = ? AND source_id = ?")
    .get(userEmail, input.source, input.sourceId) as SavedOppRow;
  return rowToSavedOpp(row);
}

export function listSavedOpportunities(userEmail: string, limit = 200): SavedOpportunity[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM saved_opportunities WHERE user_email = ? ORDER BY created_at DESC LIMIT ?")
    .all(userEmail, limit) as SavedOppRow[];
  return rows.map(rowToSavedOpp);
}

export function getSavedOpportunity(id: string, userEmail: string): SavedOpportunity | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM saved_opportunities WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as SavedOppRow | undefined;
  return row ? rowToSavedOpp(row) : null;
}

export function deleteSavedOpportunity(id: string, userEmail: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM saved_opportunities WHERE id = ? AND user_email = ?").run(id, userEmail);
  return res.changes > 0;
}

export function listSavedSourceIds(userEmail: string): Set<string> {
  const db = getDb();
  const rows = db
    .prepare("SELECT source, source_id FROM saved_opportunities WHERE user_email = ?")
    .all(userEmail) as { source: string; source_id: string }[];
  return new Set(rows.map((r) => `${r.source}:${r.source_id}`));
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- NOFO library ----------------------------------------------------------

export type NofoRecord = {
  id: string;
  userEmail: string;
  agency: string | null;
  program: string | null;
  fundingFloor: string | null;
  fundingCeiling: string | null;
  periodOfPerformance: string | null;
  keyDates: ExtractedNofo["key_dates"] | null;
  eligibility: string | null;
  evaluationCriteria: string | null;
  requiredSections: string[];
  summary: string | null;
  rawText: string;
  originalFilename: string | null;
  extractedAt: number;
  tags: string[];
  // A2 fit-scoring (migration 006). null until /api/nofos/score-batch runs.
  score: number | null;
  scoreRationale: string | null;
  scoredAt: number | null;
};

type NofoRow = {
  id: string;
  user_email: string;
  agency: string | null;
  program: string | null;
  funding_floor: string | null;
  funding_ceiling: string | null;
  period_of_performance: string | null;
  key_dates_json: string | null;
  eligibility: string | null;
  evaluation_criteria_json: string | null;
  required_sections_json: string | null;
  summary: string | null;
  raw_text: string | null;
  original_filename: string | null;
  extracted_at: number;
  tags_json: string | null;
  score: number | null;
  score_rationale: string | null;
  scored_at: number | null;
  // 032_nofo_provenance
  source_hash: string | null;
  extraction_version: string | null;
  extraction_model: string | null;
  extraction_confidence: number | null;
  opportunity_id: string | null;
  solicitation_number: string | null;
  attachments_json: string | null;
  human_corrections_json: string | null;
  updated_at: number | null;
};

function rowToNofo(row: NofoRow): NofoRecord {
  return {
    id: row.id,
    userEmail: row.user_email,
    agency: row.agency,
    program: row.program,
    fundingFloor: row.funding_floor,
    fundingCeiling: row.funding_ceiling,
    periodOfPerformance: row.period_of_performance,
    keyDates: row.key_dates_json ? safeParse<ExtractedNofo["key_dates"]>(row.key_dates_json, undefined) ?? null : null,
    eligibility: row.eligibility,
    evaluationCriteria: row.evaluation_criteria_json
      ? safeParse<string | null>(row.evaluation_criteria_json, null)
      : null,
    requiredSections: row.required_sections_json
      ? safeParse<string[]>(row.required_sections_json, [])
      : [],
    summary: row.summary,
    rawText: row.raw_text ?? "",
    originalFilename: row.original_filename,
    extractedAt: row.extracted_at,
    tags: row.tags_json ? safeParse<string[]>(row.tags_json, []) : [],
    score: row.score == null ? null : Number(row.score),
    scoreRationale: row.score_rationale,
    scoredAt: row.scored_at == null ? null : Number(row.scored_at),
  };
}

export type SaveNofoInput = {
  id?: string;
  userEmail: string;
  structured: ExtractedNofo;
  rawText: string;
  originalFilename: string | null;
  tags?: string[];
  /** Extractor identity, recorded so a later version's output is distinguishable. */
  extractionVersion?: string | null;
  extractionModel?: string | null;
  extractionConfidence?: number | null;
  opportunityId?: string | null;
  solicitationNumber?: string | null;
  attachments?: string[] | null;
};

/** Stable identity for a source document: SHA-256 over normalised raw text. */
export function nofoSourceHash(rawText: string): string | null {
  const normalized = rawText.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Idempotent NOFO persistence (V4.1 §14.5).
 *
 * Re-extracting an unchanged document must not create a second record. When a
 * row already exists for (user_email, source_hash) the extracted fields are
 * refreshed in place — except any field a human has corrected, which the
 * extractor must never overwrite.
 */
export function saveNofo(input: SaveNofoInput): NofoRecord {
  const db = getDb();
  const now = Date.now();
  const s = input.structured;
  const sourceHash = nofoSourceHash(input.rawText);

  const existing = sourceHash
    ? (db
        .prepare("SELECT * FROM nofos WHERE user_email = ? AND source_hash = ?")
        .get(input.userEmail, sourceHash) as NofoRow | undefined)
    : undefined;

  if (existing) {
    const corrected = new Set(
      Object.keys(
        existing.human_corrections_json
          ? safeParse<Record<string, unknown>>(existing.human_corrections_json, {})
          : {},
      ),
    );
    const set = (col: string, value: unknown): [string, unknown] | null =>
      corrected.has(col) ? null : [col, value];

    const updates = [
      set("agency", s.agency ?? null),
      set("program", s.program ?? null),
      set("funding_floor", s.funding_floor ?? null),
      set("funding_ceiling", s.funding_ceiling ?? null),
      set("period_of_performance", s.period_of_performance ?? null),
      set("key_dates_json", s.key_dates ? JSON.stringify(s.key_dates) : null),
      set("eligibility", s.eligibility ?? null),
      set("evaluation_criteria_json", s.evaluation_criteria ? JSON.stringify(s.evaluation_criteria) : null),
      set("required_sections_json", s.required_sections ? JSON.stringify(s.required_sections) : null),
      set("summary", s.summary ?? null),
    ].filter(Boolean) as Array<[string, unknown]>;

    updates.push(["extraction_version", input.extractionVersion ?? null]);
    updates.push(["extraction_model", input.extractionModel ?? null]);
    updates.push(["extraction_confidence", input.extractionConfidence ?? null]);
    updates.push(["updated_at", now]);

    const params: Record<string, unknown> = { id: existing.id };
    const assignments = updates.map(([col, value]) => {
      params[col] = value;
      return `${col} = @${col}`;
    });
    db.prepare(`UPDATE nofos SET ${assignments.join(", ")} WHERE id = @id`).run(params);
    return rowToNofo(db.prepare("SELECT * FROM nofos WHERE id = ?").get(existing.id) as NofoRow);
  }

  const id = input.id ?? randomId();
  db.prepare(`
    INSERT INTO nofos (
      id, user_email, agency, program, funding_floor, funding_ceiling,
      period_of_performance, key_dates_json, eligibility, evaluation_criteria_json,
      required_sections_json, summary, raw_text, original_filename, extracted_at, tags_json,
      source_hash, extraction_version, extraction_model, extraction_confidence,
      opportunity_id, solicitation_number, attachments_json, updated_at
    ) VALUES (
      @id, @user_email, @agency, @program, @funding_floor, @funding_ceiling,
      @period_of_performance, @key_dates_json, @eligibility, @evaluation_criteria_json,
      @required_sections_json, @summary, @raw_text, @original_filename, @extracted_at, @tags_json,
      @source_hash, @extraction_version, @extraction_model, @extraction_confidence,
      @opportunity_id, @solicitation_number, @attachments_json, @updated_at
    )
  `).run({
    id,
    user_email: input.userEmail,
    source_hash: sourceHash,
    extraction_version: input.extractionVersion ?? null,
    extraction_model: input.extractionModel ?? null,
    extraction_confidence: input.extractionConfidence ?? null,
    opportunity_id: input.opportunityId ?? null,
    solicitation_number: input.solicitationNumber ?? null,
    attachments_json: input.attachments ? JSON.stringify(input.attachments) : null,
    updated_at: now,
    agency: s.agency ?? null,
    program: s.program ?? null,
    funding_floor: s.funding_floor ?? null,
    funding_ceiling: s.funding_ceiling ?? null,
    period_of_performance: s.period_of_performance ?? null,
    key_dates_json: s.key_dates ? JSON.stringify(s.key_dates) : null,
    eligibility: s.eligibility ?? null,
    evaluation_criteria_json: s.evaluation_criteria ? JSON.stringify(s.evaluation_criteria) : null,
    required_sections_json: s.required_sections ? JSON.stringify(s.required_sections) : null,
    summary: s.summary ?? null,
    raw_text: input.rawText,
    original_filename: input.originalFilename,
    extracted_at: now,
    tags_json: input.tags ? JSON.stringify(input.tags) : JSON.stringify([]),
  });
  const row = db.prepare("SELECT * FROM nofos WHERE id = ?").get(id) as NofoRow;
  return rowToNofo(row);
}

export type UpdateNofoInput = {
  agency?: string | null;
  program?: string | null;
  fundingFloor?: string | null;
  fundingCeiling?: string | null;
  periodOfPerformance?: string | null;
  eligibility?: string | null;
  evaluationCriteria?: string | null;
  requiredSections?: string[];
  summary?: string | null;
  tags?: string[];
};

export function updateNofo(id: string, userEmail: string, patch: UpdateNofoInput): NofoRecord | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM nofos WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as NofoRow | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.agency !== undefined) {
    fields.push("agency = @agency");
    params.agency = patch.agency;
  }
  if (patch.program !== undefined) {
    fields.push("program = @program");
    params.program = patch.program;
  }
  if (patch.fundingFloor !== undefined) {
    fields.push("funding_floor = @funding_floor");
    params.funding_floor = patch.fundingFloor;
  }
  if (patch.fundingCeiling !== undefined) {
    fields.push("funding_ceiling = @funding_ceiling");
    params.funding_ceiling = patch.fundingCeiling;
  }
  if (patch.periodOfPerformance !== undefined) {
    fields.push("period_of_performance = @period_of_performance");
    params.period_of_performance = patch.periodOfPerformance;
  }
  if (patch.eligibility !== undefined) {
    fields.push("eligibility = @eligibility");
    params.eligibility = patch.eligibility;
  }
  if (patch.evaluationCriteria !== undefined) {
    fields.push("evaluation_criteria_json = @evaluation_criteria_json");
    params.evaluation_criteria_json = patch.evaluationCriteria == null ? null : JSON.stringify(patch.evaluationCriteria);
  }
  if (patch.requiredSections !== undefined) {
    fields.push("required_sections_json = @required_sections_json");
    params.required_sections_json = JSON.stringify(patch.requiredSections);
  }
  if (patch.summary !== undefined) {
    fields.push("summary = @summary");
    params.summary = patch.summary;
  }
  if (patch.tags !== undefined) {
    fields.push("tags_json = @tags_json");
    params.tags_json = JSON.stringify(patch.tags);
  }

  if (fields.length === 0) return rowToNofo(existing);

  db.prepare(`UPDATE nofos SET ${fields.join(", ")} WHERE id = @id`).run(params);
  const row = db.prepare("SELECT * FROM nofos WHERE id = ?").get(id) as NofoRow;
  return rowToNofo(row);
}

export function getNofo(id: string, userEmail: string): NofoRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM nofos WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as NofoRow | undefined;
  return row ? rowToNofo(row) : null;
}

export function getNofoSummary(id: string, userEmail: string): {
  id: string;
  agency: string | null;
  program: string | null;
  summary: string | null;
} | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, agency, program, summary FROM nofos WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as { id: string; agency: string | null; program: string | null; summary: string | null } | undefined;
  return row ?? null;
}

export type ListNofosFilters = {
  q?: string;
  agency?: string;
  program?: string;
  tag?: string;
  limit?: number;
  // A2: sort by fit score DESC, unscored last.
  orderBy?: "recent" | "score";
};

export function listNofos(userEmail: string, filters: ListNofosFilters = {}): NofoRecord[] {
  const db = getDb();
  const where: string[] = ["user_email = @user_email"];
  const params: Record<string, unknown> = { user_email: userEmail };

  if (filters.agency && filters.agency.trim()) {
    where.push("LOWER(COALESCE(agency, '')) LIKE @agency");
    params.agency = `%${filters.agency.trim().toLowerCase()}%`;
  }
  if (filters.program && filters.program.trim()) {
    where.push("LOWER(COALESCE(program, '')) LIKE @program");
    params.program = `%${filters.program.trim().toLowerCase()}%`;
  }
  if (filters.q && filters.q.trim()) {
    where.push(`(
      LOWER(COALESCE(summary, '')) LIKE @q
      OR LOWER(COALESCE(agency, '')) LIKE @q
      OR LOWER(COALESCE(program, '')) LIKE @q
      OR LOWER(COALESCE(eligibility, '')) LIKE @q
      OR LOWER(COALESCE(original_filename, '')) LIKE @q
    )`);
    params.q = `%${filters.q.trim().toLowerCase()}%`;
  }
  if (filters.tag && filters.tag.trim()) {
    where.push("LOWER(COALESCE(tags_json, '')) LIKE @tag");
    params.tag = `%"${filters.tag.trim().toLowerCase()}"%`;
  }

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const order =
    filters.orderBy === "score"
      ? "score DESC NULLS LAST, extracted_at DESC"
      : "extracted_at DESC";
  const rows = db
    .prepare(
      `SELECT * FROM nofos WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
    )
    .all(params) as NofoRow[];
  return rows.map(rowToNofo);
}

// A2: write a single NOFO score back. Mirrors setItemScore in lib/scouts.ts.
export function setNofoScore(
  id: string,
  userEmail: string,
  score: number,
  rationale: string,
): NofoRecord | null {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE nofos
       SET score = @score, score_rationale = @rationale, scored_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, score, rationale, now });
  if (result.changes === 0) return null;
  const row = db.prepare("SELECT * FROM nofos WHERE id = ?").get(id) as
    | NofoRow
    | undefined;
  return row ? rowToNofo(row) : null;
}

// A2: list unscored NOFOs up to a cap (used by /api/nofos/score-batch).
export function listUnscoredNofos(userEmail: string, cap = 50): NofoRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM nofos
       WHERE user_email = ? AND score IS NULL
       ORDER BY extracted_at DESC
       LIMIT ?`,
    )
    .all(userEmail, Math.min(Math.max(cap, 1), 50)) as NofoRow[];
  return rows.map(rowToNofo);
}

export function deleteNofo(id: string, userEmail: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM nofos WHERE id = ? AND user_email = ?").run(id, userEmail);
  return res.changes > 0;
}

export function nofoToExtracted(n: NofoRecord): ExtractedNofo {
  return {
    agency: n.agency ?? undefined,
    program: n.program ?? undefined,
    funding_floor: n.fundingFloor ?? undefined,
    funding_ceiling: n.fundingCeiling ?? undefined,
    period_of_performance: n.periodOfPerformance ?? undefined,
    eligibility: n.eligibility ?? undefined,
    key_dates: n.keyDates ?? undefined,
    evaluation_criteria: n.evaluationCriteria ?? undefined,
    required_sections: n.requiredSections.length ? n.requiredSections : undefined,
    summary: n.summary ?? undefined,
  };
}

// --- Funding Pools (pivot v2 — Sprint 1) -----------------------------------
// Types + status constants live in `./pools-types` so client bundles can use
// them without dragging better-sqlite3/fs into the browser.

type PoolRow = {
  id: string;
  user_email: string;
  rank: number | null;
  name: string;
  source: string | null;
  agency: string | null;
  jurisdiction: string | null;
  status: string;
  play_type: string | null;
  allocated_amount: string | null;
  unspent_amount: string | null;
  deadline_date: string | null;
  deadline_label: string | null;
  fit_summary: string | null;
  wedge: string | null;
  next_action: string | null;
  notes: string | null;
  tags_json: string | null;
  created_at: number;
  updated_at: number;
};

function rowToPool(row: PoolRow): FundingPool {
  const status = isPoolStatus(row.status) ? row.status : "discovered";
  return {
    id: row.id,
    userEmail: row.user_email,
    rank: row.rank ?? null,
    name: row.name,
    source: row.source,
    agency: row.agency,
    jurisdiction: row.jurisdiction,
    status,
    playType: row.play_type,
    allocatedAmount: row.allocated_amount,
    unspentAmount: row.unspent_amount,
    deadlineDate: row.deadline_date,
    deadlineLabel: row.deadline_label,
    fitSummary: row.fit_summary,
    wedge: row.wedge,
    nextAction: row.next_action,
    notes: row.notes,
    tags: row.tags_json ? safeParse<string[]>(row.tags_json, []) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreatePoolInput = {
  userEmail: string;
  name: string;
  rank?: number | null;
  source?: string | null;
  agency?: string | null;
  jurisdiction?: string | null;
  status?: PoolStatus;
  playType?: string | null;
  allocatedAmount?: string | null;
  unspentAmount?: string | null;
  deadlineDate?: string | null;
  deadlineLabel?: string | null;
  fitSummary?: string | null;
  wedge?: string | null;
  nextAction?: string | null;
  notes?: string | null;
  tags?: string[];
};

export function createPool(input: CreatePoolInput): FundingPool {
  const db = getDb();
  const id = randomId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO funding_pools (
      id, user_email, rank, name, source, agency, jurisdiction, status, play_type,
      allocated_amount, unspent_amount, deadline_date, deadline_label,
      fit_summary, wedge, next_action, notes, tags_json, created_at, updated_at
    ) VALUES (
      @id, @user_email, @rank, @name, @source, @agency, @jurisdiction, @status, @play_type,
      @allocated_amount, @unspent_amount, @deadline_date, @deadline_label,
      @fit_summary, @wedge, @next_action, @notes, @tags_json, @created_at, @updated_at
    )
  `).run({
    id,
    user_email: input.userEmail,
    rank: input.rank ?? null,
    name: input.name,
    source: input.source ?? null,
    agency: input.agency ?? null,
    jurisdiction: input.jurisdiction ?? null,
    status: input.status ?? "discovered",
    play_type: input.playType ?? null,
    allocated_amount: input.allocatedAmount ?? null,
    unspent_amount: input.unspentAmount ?? null,
    deadline_date: input.deadlineDate ?? null,
    deadline_label: input.deadlineLabel ?? null,
    fit_summary: input.fitSummary ?? null,
    wedge: input.wedge ?? null,
    next_action: input.nextAction ?? null,
    notes: input.notes ?? null,
    tags_json: JSON.stringify(input.tags ?? []),
    created_at: now,
    updated_at: now,
  });
  const row = db.prepare("SELECT * FROM funding_pools WHERE id = ?").get(id) as PoolRow;
  return rowToPool(row);
}

export type UpdatePoolInput = Partial<Omit<CreatePoolInput, "userEmail">>;

export function updatePool(id: string, userEmail: string, patch: UpdatePoolInput): FundingPool | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM funding_pools WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as PoolRow | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const params: Record<string, unknown> = { id };

  const mapping: Array<[keyof UpdatePoolInput, string, (v: unknown) => unknown]> = [
    ["rank", "rank", (v) => (v == null ? null : Number(v))],
    ["name", "name", (v) => String(v ?? "").trim() || existing.name],
    ["source", "source", (v) => (v as string | null) ?? null],
    ["agency", "agency", (v) => (v as string | null) ?? null],
    ["jurisdiction", "jurisdiction", (v) => (v as string | null) ?? null],
    ["status", "status", (v) => (typeof v === "string" && isPoolStatus(v) ? v : existing.status)],
    ["playType", "play_type", (v) => (v as string | null) ?? null],
    ["allocatedAmount", "allocated_amount", (v) => (v as string | null) ?? null],
    ["unspentAmount", "unspent_amount", (v) => (v as string | null) ?? null],
    ["deadlineDate", "deadline_date", (v) => (v as string | null) ?? null],
    ["deadlineLabel", "deadline_label", (v) => (v as string | null) ?? null],
    ["fitSummary", "fit_summary", (v) => (v as string | null) ?? null],
    ["wedge", "wedge", (v) => (v as string | null) ?? null],
    ["nextAction", "next_action", (v) => (v as string | null) ?? null],
    ["notes", "notes", (v) => (v as string | null) ?? null],
  ];

  for (const [key, col, normalize] of mapping) {
    if (key in patch) {
      fields.push(`${col} = @${col}`);
      params[col] = normalize((patch as Record<string, unknown>)[key]);
    }
  }
  if (patch.tags !== undefined) {
    fields.push("tags_json = @tags_json");
    params.tags_json = JSON.stringify(patch.tags ?? []);
  }

  if (fields.length === 0) return rowToPool(existing);

  fields.push("updated_at = @updated_at");
  params.updated_at = Date.now();
  db.prepare(`UPDATE funding_pools SET ${fields.join(", ")} WHERE id = @id`).run(params);
  const row = db.prepare("SELECT * FROM funding_pools WHERE id = ?").get(id) as PoolRow;
  return rowToPool(row);
}

export function getPool(id: string, userEmail: string): FundingPool | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM funding_pools WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as PoolRow | undefined;
  return row ? rowToPool(row) : null;
}

export function getPoolSummary(id: string, userEmail: string): {
  id: string;
  name: string;
  status: PoolStatus;
  agency: string | null;
} | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name, status, agency FROM funding_pools WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as { id: string; name: string; status: string; agency: string | null } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: isPoolStatus(row.status) ? row.status : "discovered",
    agency: row.agency,
  };
}

export type ListPoolsFilters = {
  status?: PoolStatus | "all";
  q?: string;
  limit?: number;
};

export function listPools(userEmail: string, filters: ListPoolsFilters = {}): FundingPool[] {
  const db = getDb();
  const where: string[] = ["user_email = @user_email"];
  const params: Record<string, unknown> = { user_email: userEmail };
  if (filters.status && filters.status !== "all" && isPoolStatus(filters.status)) {
    where.push("status = @status");
    params.status = filters.status;
  }
  if (filters.q && filters.q.trim()) {
    where.push(`(
      LOWER(COALESCE(name, '')) LIKE @q
      OR LOWER(COALESCE(agency, '')) LIKE @q
      OR LOWER(COALESCE(source, '')) LIKE @q
      OR LOWER(COALESCE(jurisdiction, '')) LIKE @q
      OR LOWER(COALESCE(fit_summary, '')) LIKE @q
      OR LOWER(COALESCE(notes, '')) LIKE @q
    )`);
    params.q = `%${filters.q.trim().toLowerCase()}%`;
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  // ORDER: rank NULLS LAST, then deadline ascending (NULLs last), then updated desc
  const rows = db
    .prepare(
      `SELECT * FROM funding_pools WHERE ${where.join(" AND ")}
       ORDER BY (rank IS NULL), rank ASC, (deadline_date IS NULL), deadline_date ASC, updated_at DESC
       LIMIT ${limit}`,
    )
    .all(params) as PoolRow[];
  return rows.map(rowToPool);
}

export function deletePool(id: string, userEmail: string): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM funding_pools WHERE id = ? AND user_email = ?").run(id, userEmail);
  return res.changes > 0;
}

export function countPoolsForUser(userEmail: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as n FROM funding_pools WHERE user_email = ?")
    .get(userEmail) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

// Upsert an auto-discovered funding pool by its natural key (user + name +
// source). On a re-scan we REFRESH the discovery/amount/scoring fields but
// DELIBERATELY preserve any human-advanced status, notes, and play framing —
// once a pool is researched/engaged the operator owns it, the scanner only
// keeps the numbers fresh. (Same preserve-on-upsert discipline as teaming.)
export function upsertDiscoveredPool(
  input: CreatePoolInput & { name: string; source: string },
): { pool: FundingPool; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM funding_pools
       WHERE user_email = ? AND source = ? AND LOWER(name) = LOWER(?)
       LIMIT 1`,
    )
    .get(input.userEmail, input.source, input.name) as PoolRow | undefined;

  if (!existing) {
    return { pool: createPool(input), created: true };
  }

  const now = Date.now();
  db.prepare(
    `UPDATE funding_pools SET
       rank = @rank,
       agency = @agency,
       jurisdiction = @jurisdiction,
       allocated_amount = @allocated_amount,
       unspent_amount = @unspent_amount,
       deadline_date = @deadline_date,
       deadline_label = @deadline_label,
       fit_summary = @fit_summary,
       tags_json = @tags_json,
       updated_at = @updated_at
     WHERE id = @id`,
  ).run({
    id: existing.id,
    rank: input.rank ?? existing.rank,
    agency: input.agency ?? existing.agency,
    jurisdiction: input.jurisdiction ?? existing.jurisdiction,
    allocated_amount: input.allocatedAmount ?? existing.allocated_amount,
    unspent_amount: input.unspentAmount ?? existing.unspent_amount,
    deadline_date: input.deadlineDate ?? existing.deadline_date,
    deadline_label: input.deadlineLabel ?? existing.deadline_label,
    fit_summary: input.fitSummary ?? existing.fit_summary,
    tags_json: JSON.stringify(input.tags ?? safeParse<string[]>(existing.tags_json ?? "[]", [])),
    updated_at: now,
  });
  const row = db.prepare("SELECT * FROM funding_pools WHERE id = ?").get(existing.id) as PoolRow;
  return { pool: rowToPool(row), created: false };
}

export function listDraftsForPool(poolId: string, userEmail: string): DraftRecord[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM drafts WHERE pool_id = ? AND user_email = ? ORDER BY updated_at DESC")
    .all(poolId, userEmail) as DraftRow[];
  return rows.map(rowToDraft);
}

// Status vocabulary and the permitted-transition machine live in
// ./draft-state (pure, unit-tested). Re-exported so existing importers of
// DRAFT_STATUSES / DraftStatus / isDraftStatus from "@/lib/db" keep working.
export {
  DRAFT_STATUSES,
  DRAFT_STATUS_LABELS,
  TERMINAL_STATUSES,
  REVIEW_STATUSES,
  isDraftStatus,
  isTerminal,
  canTransition,
  allowedTransitions,
  type DraftStatus,
} from "./draft-state";

export function getDraftStatus(
  draftId: string,
  userEmail: string,
): { status: DraftStatus; updatedAt: number | null; preflightAt: number | null; override: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT status, status_updated_at, preflight_run_at, submission_override_reason
         FROM drafts WHERE id = ? AND user_email = ?`,
    )
    .get(draftId, userEmail) as
    | {
        status: string | null;
        status_updated_at: number | null;
        preflight_run_at: number | null;
        submission_override_reason: string | null;
      }
    | undefined;
  if (!row) return null;
  const status = isDraftStatus(row.status ?? "drafting") ? (row.status as DraftStatus) : "drafting";
  return {
    status,
    updatedAt: row.status_updated_at,
    preflightAt: row.preflight_run_at,
    override: row.submission_override_reason,
  };
}

/** Lifecycle status for every draft a user owns — one query, for list views. */
export function listDraftStatuses(userEmail: string): Map<string, DraftStatus> {
  const rows = getDb()
    .prepare(`SELECT id, status FROM drafts WHERE user_email = ?`)
    .all(userEmail) as { id: string; status: string | null }[];
  const out = new Map<string, DraftStatus>();
  for (const r of rows) {
    out.set(r.id, isDraftStatus(r.status ?? "drafting") ? (r.status as DraftStatus) : "drafting");
  }
  return out;
}

/**
 * Set a draft's status, rejecting transitions the state machine forbids
 * (V4.1 §14.7). Pass `reopen: true` to move a terminal record back into work —
 * deliberately explicit so reopening is an auditable act, not an accident.
 *
 * Throws on an invalid transition rather than returning false: a caller that
 * ignores the boolean would otherwise believe the write succeeded.
 */
export function setDraftStatus(input: {
  draftId: string;
  userEmail: string;
  status: DraftStatus;
  preflightResult?: Record<string, unknown> | null;
  override?: string | null;
  reopen?: boolean;
}): boolean {
  const current = getDraftStatus(input.draftId, input.userEmail);
  if (current) {
    assertTransition(current.status, input.status, { reopen: input.reopen });
  }
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE drafts
         SET status = ?, status_updated_at = ?,
             preflight_result_json = COALESCE(?, preflight_result_json),
             preflight_run_at = COALESCE(?, preflight_run_at),
             submission_override_reason = COALESCE(?, submission_override_reason)
       WHERE id = ? AND user_email = ?`,
    )
    .run(
      input.status,
      now,
      input.preflightResult ? JSON.stringify(input.preflightResult) : null,
      input.preflightResult ? now : null,
      input.override ?? null,
      input.draftId,
      input.userEmail,
    );
  return res.changes > 0;
}

export function setDraftPreflightResult(input: {
  draftId: string;
  userEmail: string;
  result: Record<string, unknown>;
}): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `UPDATE drafts SET preflight_result_json = ?, preflight_run_at = ? WHERE id = ? AND user_email = ?`,
    )
    .run(JSON.stringify(input.result), now, input.draftId, input.userEmail);
  return res.changes > 0;
}

// Drafts that include this partner on their curated roster (Item 4.1). Falls
// back through the legacy partnerLead / partnerSelection shapes via
// readDraftRoster, so old drafts still resolve. Excluded partners are omitted.
// We scan in JS because meta_json is a TEXT blob; single-user volume makes this
// fine.
export function listDraftsForPartner(partnerId: string, userEmail: string): DraftRecord[] {
  const all = listDrafts(userEmail, 500);
  return all.filter((d) => includedPartnerIds(readDraftRoster(d.meta)).includes(partnerId));
}

// --- Copilot chat persistence (Sprint 3+ — table from 007_copilot_chats.sql)

export type CopilotChatRecord = {
  id: string;
  userEmail: string;
  contextKind: string | null;
  contextId: string | null;
  title: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CopilotMessageRecord = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  createdAtMs: number;
};

type CopilotChatRow = {
  id: string;
  user_email: string;
  context_kind: string | null;
  context_id: string | null;
  title: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

type CopilotMessageRow = {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  model: string | null;
  created_at_ms: number;
};

function rowToCopilotChat(row: CopilotChatRow): CopilotChatRecord {
  return {
    id: row.id,
    userEmail: row.user_email,
    contextKind: row.context_kind,
    contextId: row.context_id,
    title: row.title,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function rowToCopilotMessage(row: CopilotMessageRow): CopilotMessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as CopilotMessageRecord["role"],
    content: row.content,
    model: row.model,
    createdAtMs: Number(row.created_at_ms),
  };
}

export function createCopilotChat(input: {
  userEmail: string;
  contextKind?: string | null;
  contextId?: string | null;
  title?: string | null;
}): CopilotChatRecord {
  const db = getDb();
  const id = randomId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO copilot_chats (id, user_email, context_kind, context_id, title, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userEmail,
    input.contextKind ?? null,
    input.contextId ?? null,
    input.title ?? null,
    now,
    now,
  );
  const row = db.prepare("SELECT * FROM copilot_chats WHERE id = ?").get(id) as CopilotChatRow;
  return rowToCopilotChat(row);
}

export function getCopilotChat(id: string, userEmail: string): CopilotChatRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM copilot_chats WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as CopilotChatRow | undefined;
  return row ? rowToCopilotChat(row) : null;
}

export function listCopilotChats(userEmail: string, limit = 50): CopilotChatRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM copilot_chats WHERE user_email = ? ORDER BY updated_at_ms DESC LIMIT ?",
    )
    .all(userEmail, limit) as CopilotChatRow[];
  return rows.map(rowToCopilotChat);
}

export function listCopilotMessages(chatId: string, userEmail: string): CopilotMessageRecord[] {
  const db = getDb();
  const owns = db
    .prepare("SELECT 1 FROM copilot_chats WHERE id = ? AND user_email = ?")
    .get(chatId, userEmail);
  if (!owns) return [];
  const rows = db
    .prepare(
      "SELECT * FROM copilot_messages WHERE chat_id = ? ORDER BY created_at_ms ASC",
    )
    .all(chatId) as CopilotMessageRow[];
  return rows.map(rowToCopilotMessage);
}

export function appendCopilotMessage(input: {
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string | null;
}): CopilotMessageRecord {
  const db = getDb();
  const id = randomId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO copilot_messages (id, chat_id, role, content, model, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.chatId, input.role, input.content, input.model ?? null, now);
  db.prepare("UPDATE copilot_chats SET updated_at_ms = ? WHERE id = ?").run(now, input.chatId);
  const row = db.prepare("SELECT * FROM copilot_messages WHERE id = ?").get(id) as CopilotMessageRow;
  return rowToCopilotMessage(row);
}

export function updateCopilotChatTitle(id: string, userEmail: string, title: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE copilot_chats SET title = ?, updated_at_ms = ? WHERE id = ? AND user_email = ?",
  ).run(title, Date.now(), id, userEmail);
}

export function deleteCopilotChat(id: string, userEmail: string): boolean {
  const db = getDb();
  const res = db
    .prepare("DELETE FROM copilot_chats WHERE id = ? AND user_email = ?")
    .run(id, userEmail);
  return res.changes > 0;
}

// --- Strategic scoring + compliance on saved_opportunities (migration 008) --

export function setOpportunityStrategicScore(
  id: string,
  userEmail: string,
  score: number,
  detail: Record<string, unknown>,
): SavedOpportunity | null {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE saved_opportunities
       SET strategic_score = @score, strategic_score_detail = @detail, strategic_scored_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, score, detail: JSON.stringify(detail), now });
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM saved_opportunities WHERE id = ?")
    .get(id) as SavedOppRow | undefined;
  return row ? rowToSavedOpp(row) : null;
}

export function setOpportunityComplianceResult(
  id: string,
  userEmail: string,
  status: string,
  detail: Record<string, unknown>[],
): SavedOpportunity | null {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE saved_opportunities
       SET compliance_status = @status, compliance_detail = @detail, compliance_checked_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, status, detail: JSON.stringify(detail), now });
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM saved_opportunities WHERE id = ?")
    .get(id) as SavedOppRow | undefined;
  return row ? rowToSavedOpp(row) : null;
}

export type PipelineStage =
  | "identification"
  | "development"
  | "submission"
  | "award_tracking"
  | "execution";

export const PIPELINE_STAGES: PipelineStage[] = [
  "identification",
  "development",
  "submission",
  "award_tracking",
  "execution",
];

export function isPipelineStage(s: string): s is PipelineStage {
  return (PIPELINE_STAGES as string[]).includes(s);
}

export function setOpportunityPipelineStage(
  id: string,
  userEmail: string,
  stage: PipelineStage | null,
  meta?: Record<string, unknown> | null,
): SavedOpportunity | null {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE saved_opportunities
       SET pipeline_stage = @stage, pipeline_updated_at = @now, pipeline_meta = @meta
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({
      id,
      user_email: userEmail,
      stage: stage ?? null,
      now,
      meta: meta ? JSON.stringify(meta) : null,
    });
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM saved_opportunities WHERE id = ?")
    .get(id) as SavedOppRow | undefined;
  return row ? rowToSavedOpp(row) : null;
}

// --- Win/loss disposition (migration 023, Item 3.1) -------------------------

// Project a saved opportunity onto the five matching dimensions the feedback
// loop reasons over. funder = agency; mechanism = NAICS (the closest stable
// proxy we store today); dollar band derived from the ceiling, then the floor;
// partner + prime/sub role are read from pipeline_meta when present (they become
// first-class once item 4.1 lands per-draft partner selection).
export function opportunityDimensions(opp: SavedOpportunity): OppDimensions {
  const meta = opp.pipelineMeta ?? {};
  const partner = typeof meta.partner === "string" ? meta.partner : null;
  const rawRole = typeof meta.role === "string" ? meta.role.toLowerCase() : null;
  const role = rawRole === "prime" || rawRole === "sub" ? rawRole : null;
  const dollars =
    parseDollarAmount(opp.fundingCeiling) ?? parseDollarAmount(opp.fundingFloor);
  return {
    funder: opp.agency,
    mechanism: opp.naics,
    dollarBand: dollarBand(dollars),
    partner,
    role,
  };
}

export function setOpportunityDisposition(
  id: string,
  userEmail: string,
  disposition: Disposition,
  note?: string | null,
): SavedOpportunity | null {
  if (!isDisposition(disposition)) {
    throw new Error(`invalid disposition: ${disposition}`);
  }
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE saved_opportunities
       SET disposition = @disposition, disposition_note = @note, disposition_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, disposition, note: note ?? null, now });
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM saved_opportunities WHERE id = ?")
    .get(id) as SavedOppRow | undefined;
  return row ? rowToSavedOpp(row) : null;
}

// Undo: clear a disposition back to "undecided".
export function clearOpportunityDisposition(
  id: string,
  userEmail: string,
): SavedOpportunity | null {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE saved_opportunities
       SET disposition = NULL, disposition_note = NULL, disposition_at = NULL
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail });
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM saved_opportunities WHERE id = ?")
    .get(id) as SavedOppRow | undefined;
  return row ? rowToSavedOpp(row) : null;
}

// Every decided opportunity, most-recent first, projected to disposition records
// for the council enrichment + calibration curve. Only rows with a disposition
// set are returned (the partial index makes this a cheap scan).
export function listOpportunityDispositions(
  userEmail: string,
  limit = 500,
): DispositionRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM saved_opportunities
       WHERE user_email = ? AND disposition IS NOT NULL
       ORDER BY disposition_at DESC LIMIT ?`,
    )
    .all(userEmail, limit) as SavedOppRow[];
  return rows
    .map(rowToSavedOpp)
    .filter((opp) => opp.disposition != null && isDisposition(opp.disposition))
    .map((opp) => ({
      opportunityId: opp.id,
      title: opp.title,
      disposition: opp.disposition as Disposition,
      note: opp.dispositionNote,
      at: opp.dispositionAt ?? 0,
      dims: opportunityDimensions(opp),
    }));
}

// Pairs of (council/strategic score, disposition) for the calibration curve.
// Prefers the council post-score recorded on council_runs; falls back to the
// opportunity's strategic_score. Only decided-or-disposed rows are included.
export function listDispositionScoreSamples(
  userEmail: string,
  limit = 1000,
): { score: number; disposition: Disposition }[] {
  const dispositions = listOpportunityDispositions(userEmail, limit);
  const out: { score: number; disposition: Disposition }[] = [];
  for (const d of dispositions) {
    const opp = getSavedOpportunity(d.opportunityId, userEmail);
    if (!opp || opp.strategicScore == null) continue;
    out.push({ score: opp.strategicScore, disposition: d.disposition });
  }
  return out;
}

// --- Contact intelligence (migration 008) -----------------------------------

export type ContactRelationshipQuality =
  | "unknown"
  | "cold"
  | "warm"
  | "active"
  | "champion";

export type ContactComplianceFlag =
  | "procurement_officer"
  | "political_figure"
  | "embargo"
  | null;

export type ContactRecord = {
  id: string;
  userEmail: string;
  name: string;
  title: string | null;
  agency: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  relationshipQuality: ContactRelationshipQuality;
  lastContactAt: number | null;
  contactCount: number;
  responseRate: number | null;
  preferredMethod: string | null;
  bestTime: string | null;
  successNotes: string | null;
  complianceFlag: ContactComplianceFlag;
  complianceNote: string | null;
  tags: string[];
  notes: string | null;
  raw: Record<string, unknown> | null;
  // Item 4.3 — cold-outreach pipeline fields (migration 025).
  outreachStatus: OutreachStatus;
  introDraft: string | null;
  introDraftAt: number | null;
  source: string | null;
  createdAt: number;
  updatedAt: number;
};

type ContactRow = {
  id: string;
  user_email: string;
  name: string;
  title: string | null;
  agency: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  relationship_quality: string;
  last_contact_at: number | null;
  contact_count: number;
  response_rate: number | null;
  preferred_method: string | null;
  best_time: string | null;
  success_notes: string | null;
  compliance_flag: string | null;
  compliance_note: string | null;
  tags_json: string | null;
  notes: string | null;
  raw_json: string | null;
  outreach_status?: string | null;
  intro_draft?: string | null;
  intro_draft_at?: number | null;
  source?: string | null;
  created_at: number;
  updated_at: number;
};

function isRelationshipQuality(s: string): s is ContactRelationshipQuality {
  return ["unknown", "cold", "warm", "active", "champion"].includes(s);
}

function rowToContact(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    userEmail: row.user_email,
    name: row.name,
    title: row.title,
    agency: row.agency,
    email: row.email,
    phone: row.phone,
    linkedinUrl: row.linkedin_url,
    relationshipQuality: isRelationshipQuality(row.relationship_quality)
      ? row.relationship_quality
      : "unknown",
    lastContactAt: row.last_contact_at == null ? null : Number(row.last_contact_at),
    contactCount: Number(row.contact_count ?? 0),
    responseRate: row.response_rate == null ? null : Number(row.response_rate),
    preferredMethod: row.preferred_method,
    bestTime: row.best_time,
    successNotes: row.success_notes,
    complianceFlag: (row.compliance_flag as ContactComplianceFlag) ?? null,
    complianceNote: row.compliance_note,
    tags: row.tags_json ? safeParse<string[]>(row.tags_json, []) : [],
    notes: row.notes,
    raw: row.raw_json ? safeParse<Record<string, unknown>>(row.raw_json, {}) : null,
    outreachStatus: isOutreachStatus(row.outreach_status)
      ? row.outreach_status
      : DEFAULT_OUTREACH_STATUS,
    introDraft: row.intro_draft ?? null,
    introDraftAt: row.intro_draft_at == null ? null : Number(row.intro_draft_at),
    source: row.source ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateContactInput = {
  userEmail: string;
  name: string;
  title?: string | null;
  agency?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  relationshipQuality?: ContactRelationshipQuality;
  preferredMethod?: string | null;
  bestTime?: string | null;
  successNotes?: string | null;
  complianceFlag?: ContactComplianceFlag;
  complianceNote?: string | null;
  tags?: string[];
  notes?: string | null;
  raw?: Record<string, unknown> | null;
  outreachStatus?: OutreachStatus;
  source?: string | null;
};

export function createContact(input: CreateContactInput): ContactRecord {
  const db = getDb();
  const id = randomId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO contacts (
      id, user_email, name, title, agency, email, phone, linkedin_url,
      relationship_quality, last_contact_at, contact_count, response_rate,
      preferred_method, best_time, success_notes,
      compliance_flag, compliance_note,
      tags_json, notes, raw_json, outreach_status, source, created_at, updated_at
    ) VALUES (
      @id, @user_email, @name, @title, @agency, @email, @phone, @linkedin_url,
      @relationship_quality, NULL, 0, NULL,
      @preferred_method, @best_time, @success_notes,
      @compliance_flag, @compliance_note,
      @tags_json, @notes, @raw_json, @outreach_status, @source, @created_at, @updated_at
    )
  `).run({
    id,
    user_email: input.userEmail,
    name: input.name,
    title: input.title ?? null,
    agency: input.agency ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    linkedin_url: input.linkedinUrl ?? null,
    relationship_quality: input.relationshipQuality ?? "unknown",
    preferred_method: input.preferredMethod ?? null,
    best_time: input.bestTime ?? null,
    success_notes: input.successNotes ?? null,
    compliance_flag: input.complianceFlag ?? null,
    compliance_note: input.complianceNote ?? null,
    tags_json: JSON.stringify(input.tags ?? []),
    notes: input.notes ?? null,
    raw_json: input.raw ? JSON.stringify(input.raw) : null,
    outreach_status: input.outreachStatus ?? DEFAULT_OUTREACH_STATUS,
    source: input.source ?? null,
    created_at: now,
    updated_at: now,
  });
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow;
  return rowToContact(row);
}

export type UpdateContactInput = Partial<Omit<CreateContactInput, "userEmail">>;

export function updateContact(
  id: string,
  userEmail: string,
  patch: UpdateContactInput,
): ContactRecord | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM contacts WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as ContactRow | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const params: Record<string, unknown> = { id };

  if (patch.name !== undefined) { fields.push("name = @name"); params.name = patch.name; }
  if (patch.title !== undefined) { fields.push("title = @title"); params.title = patch.title ?? null; }
  if (patch.agency !== undefined) { fields.push("agency = @agency"); params.agency = patch.agency ?? null; }
  if (patch.email !== undefined) { fields.push("email = @email"); params.email = patch.email ?? null; }
  if (patch.phone !== undefined) { fields.push("phone = @phone"); params.phone = patch.phone ?? null; }
  if (patch.linkedinUrl !== undefined) { fields.push("linkedin_url = @linkedin_url"); params.linkedin_url = patch.linkedinUrl ?? null; }
  if (patch.relationshipQuality !== undefined) { fields.push("relationship_quality = @relationship_quality"); params.relationship_quality = patch.relationshipQuality ?? "unknown"; }
  if (patch.preferredMethod !== undefined) { fields.push("preferred_method = @preferred_method"); params.preferred_method = patch.preferredMethod ?? null; }
  if (patch.bestTime !== undefined) { fields.push("best_time = @best_time"); params.best_time = patch.bestTime ?? null; }
  if (patch.successNotes !== undefined) { fields.push("success_notes = @success_notes"); params.success_notes = patch.successNotes ?? null; }
  if (patch.complianceFlag !== undefined) { fields.push("compliance_flag = @compliance_flag"); params.compliance_flag = patch.complianceFlag ?? null; }
  if (patch.complianceNote !== undefined) { fields.push("compliance_note = @compliance_note"); params.compliance_note = patch.complianceNote ?? null; }
  if (patch.notes !== undefined) { fields.push("notes = @notes"); params.notes = patch.notes ?? null; }
  if (patch.tags !== undefined) { fields.push("tags_json = @tags_json"); params.tags_json = JSON.stringify(patch.tags ?? []); }
  if (patch.raw !== undefined) { fields.push("raw_json = @raw_json"); params.raw_json = patch.raw ? JSON.stringify(patch.raw) : null; }

  if (fields.length === 0) return rowToContact(existing);

  fields.push("updated_at = @updated_at");
  params.updated_at = Date.now();
  db.prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = @id`).run(params);
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow;
  return rowToContact(row);
}

// Record a contact interaction: increment contact_count, update last_contact_at.
export function recordContactInteraction(
  id: string,
  userEmail: string,
  responded: boolean,
): ContactRecord | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM contacts WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as ContactRow | undefined;
  if (!existing) return null;

  const now = Date.now();
  const newCount = Number(existing.contact_count ?? 0) + 1;
  // Incremental response rate average.
  const prevRate = existing.response_rate == null ? null : Number(existing.response_rate);
  const newRate =
    prevRate == null
      ? responded ? 1.0 : 0.0
      : (prevRate * (newCount - 1) + (responded ? 1 : 0)) / newCount;

  db.prepare(
    `UPDATE contacts
     SET contact_count = @count, last_contact_at = @now, response_rate = @rate, updated_at = @now
     WHERE id = @id AND user_email = @user_email`,
  ).run({ id, count: newCount, now, rate: newRate, user_email: userEmail });

  const row = db.prepare("SELECT * FROM contacts WHERE id = ? AND user_email = ?").get(id, userEmail) as ContactRow;
  return rowToContact(row);
}

export function getContact(id: string, userEmail: string): ContactRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM contacts WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as ContactRow | undefined;
  return row ? rowToContact(row) : null;
}

export type ListContactsFilters = {
  q?: string;
  agency?: string;
  complianceFlag?: string;
  outreachStatus?: string;
  source?: string;
  limit?: number;
};

export function listContacts(
  userEmail: string,
  filters: ListContactsFilters = {},
): ContactRecord[] {
  const db = getDb();
  const where: string[] = ["user_email = @user_email"];
  const params: Record<string, unknown> = { user_email: userEmail };

  if (filters.agency?.trim()) {
    where.push("LOWER(COALESCE(agency, '')) LIKE @agency");
    params.agency = `%${filters.agency.trim().toLowerCase()}%`;
  }
  if (filters.complianceFlag?.trim()) {
    where.push("compliance_flag = @compliance_flag");
    params.compliance_flag = filters.complianceFlag.trim();
  }
  if (filters.outreachStatus?.trim()) {
    where.push("outreach_status = @outreach_status");
    params.outreach_status = filters.outreachStatus.trim();
  }
  if (filters.source?.trim()) {
    where.push("source = @source");
    params.source = filters.source.trim();
  }
  if (filters.q?.trim()) {
    where.push(`(
      LOWER(COALESCE(name, '')) LIKE @q
      OR LOWER(COALESCE(agency, '')) LIKE @q
      OR LOWER(COALESCE(email, '')) LIKE @q
      OR LOWER(COALESCE(title, '')) LIKE @q
      OR LOWER(COALESCE(notes, '')) LIKE @q
    )`);
    params.q = `%${filters.q.trim().toLowerCase()}%`;
  }

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const rows = db
    .prepare(
      `SELECT * FROM contacts WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`,
    )
    .all(params) as ContactRow[];
  return rows.map(rowToContact);
}

export function deleteContact(id: string, userEmail: string): boolean {
  const db = getDb();
  const res = db
    .prepare("DELETE FROM contacts WHERE id = ? AND user_email = ?")
    .run(id, userEmail);
  return res.changes > 0;
}

// Item 4.3 — set the cold-outreach pipeline status for a contact.
export function setContactOutreachStatus(
  id: string,
  userEmail: string,
  status: OutreachStatus,
): ContactRecord | null {
  if (!isOutreachStatus(status)) throw new Error(`invalid outreach status: ${status}`);
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE contacts SET outreach_status = @status, updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, status, now: Date.now() });
  if (res.changes === 0) return null;
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow;
  return rowToContact(row);
}

// Item 4.3 — store a generated cold-intro DRAFT on a contact. NOTHING is sent;
// this only persists reviewable text the operator can copy out by hand.
export function setContactIntroDraft(
  id: string,
  userEmail: string,
  draft: string,
): ContactRecord | null {
  const db = getDb();
  const now = Date.now();
  const res = db
    .prepare(
      `UPDATE contacts SET intro_draft = @draft, intro_draft_at = @now, updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, draft, now });
  if (res.changes === 0) return null;
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow;
  return rowToContact(row);
}

// Item 4.3 — the set of dedupe keys already present for this user, so the
// LinkedIn importer can skip leads it has already ingested (idempotent re-runs).
export function existingContactDedupeKeys(
  userEmail: string,
  keyOf: (c: { linkedinUrl: string | null; name: string; agency: string | null }) => string,
): Set<string> {
  const db = getDb();
  const rows = db
    .prepare("SELECT name, agency, linkedin_url FROM contacts WHERE user_email = ?")
    .all(userEmail) as { name: string; agency: string | null; linkedin_url: string | null }[];
  return new Set(
    rows.map((r) => keyOf({ name: r.name, agency: r.agency, linkedinUrl: r.linkedin_url })),
  );
}

// Link / unlink a contact to a saved opportunity.
export function linkContactOpportunity(
  contactId: string,
  opportunityId: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO contact_opportunities (contact_id, opportunity_id, created_at)
    VALUES (?, ?, ?)
  `).run(contactId, opportunityId, Date.now());
}

export function unlinkContactOpportunity(
  contactId: string,
  opportunityId: string,
): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM contact_opportunities WHERE contact_id = ? AND opportunity_id = ?",
  ).run(contactId, opportunityId);
}

export function listContactsForOpportunity(
  opportunityId: string,
  userEmail: string,
): ContactRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.* FROM contacts c
       INNER JOIN contact_opportunities co ON co.contact_id = c.id
       WHERE co.opportunity_id = ? AND c.user_email = ?
       ORDER BY c.updated_at DESC`,
    )
    .all(opportunityId, userEmail) as ContactRow[];
  return rows.map(rowToContact);
}

// ---------------------------------------------------------------------------
// Item 4.5 — persisted non-profit scanner candidates (migration 026).
// A re-scan refreshes scores/reasons but PRESERVES disposition + any promoted
// contact link on rows already triaged. Nothing here sends anything.
// ---------------------------------------------------------------------------

export type NonprofitCandidateRecord = {
  id: string;
  userEmail: string;
  opportunityId: string;
  ein: string | null;
  name: string;
  nteeCode: string | null;
  state: string | null;
  source: string;
  sourceUrl: string | null;
  revenueUsd: number | null;
  relevanceScore: number;
  reasons: string[];
  themes: string[];
  disposition: NonprofitDisposition;
  dedupeKey: string;
  promotedContactId: string | null;
  createdAt: number;
  updatedAt: number;
};

type NonprofitCandidateRow = {
  id: string;
  user_email: string;
  opportunity_id: string;
  ein: string | null;
  name: string;
  ntee_code: string | null;
  state: string | null;
  source: string;
  source_url: string | null;
  revenue_usd: number | null;
  relevance_score: number;
  reasons_json: string;
  themes_json: string;
  disposition: string;
  dedupe_key: string;
  promoted_contact_id: string | null;
  created_at: number;
  updated_at: number;
};

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function rowToNonprofitCandidate(row: NonprofitCandidateRow): NonprofitCandidateRecord {
  return {
    id: row.id,
    userEmail: row.user_email,
    opportunityId: row.opportunity_id,
    ein: row.ein,
    name: row.name,
    nteeCode: row.ntee_code,
    state: row.state,
    source: row.source,
    sourceUrl: row.source_url,
    revenueUsd: row.revenue_usd,
    relevanceScore: row.relevance_score,
    reasons: parseJsonArray(row.reasons_json),
    themes: parseJsonArray(row.themes_json),
    disposition: isNonprofitDisposition(row.disposition) ? row.disposition : "new",
    dedupeKey: row.dedupe_key,
    promotedContactId: row.promoted_contact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type UpsertNonprofitCandidateInput = {
  userEmail: string;
  opportunityId: string;
  ein: string | null;
  name: string;
  nteeCode: string | null;
  state: string | null;
  source: string;
  sourceUrl: string | null;
  revenueUsd: number | null;
  relevanceScore: number;
  reasons: string[];
  themes: string[];
  dedupeKey: string;
};

// Insert or refresh a candidate. On a re-scan (same user+opportunity+dedupe_key)
// we update the discovery/scoring fields but DELIBERATELY leave disposition and
// promoted_contact_id untouched, so user triage survives.
export function upsertNonprofitCandidate(
  input: UpsertNonprofitCandidateInput,
): NonprofitCandidateRecord {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO nonprofit_candidates (
       id, user_email, opportunity_id, ein, name, ntee_code, state, source,
       source_url, revenue_usd, relevance_score, reasons_json, themes_json,
       disposition, dedupe_key, promoted_contact_id, created_at, updated_at
     ) VALUES (
       @id, @user_email, @opportunity_id, @ein, @name, @ntee_code, @state, @source,
       @source_url, @revenue_usd, @relevance_score, @reasons_json, @themes_json,
       'new', @dedupe_key, NULL, @now, @now
     )
     ON CONFLICT(user_email, opportunity_id, dedupe_key) DO UPDATE SET
       ein = excluded.ein,
       name = excluded.name,
       ntee_code = excluded.ntee_code,
       state = excluded.state,
       source = excluded.source,
       source_url = excluded.source_url,
       revenue_usd = excluded.revenue_usd,
       relevance_score = excluded.relevance_score,
       reasons_json = excluded.reasons_json,
       themes_json = excluded.themes_json,
       updated_at = excluded.updated_at`,
  ).run({
    id,
    user_email: input.userEmail,
    opportunity_id: input.opportunityId,
    ein: input.ein,
    name: input.name,
    ntee_code: input.nteeCode,
    state: input.state,
    source: input.source,
    source_url: input.sourceUrl,
    revenue_usd: input.revenueUsd,
    relevance_score: input.relevanceScore,
    reasons_json: JSON.stringify(input.reasons),
    themes_json: JSON.stringify(input.themes),
    dedupe_key: input.dedupeKey,
    now,
  });
  const row = db
    .prepare(
      "SELECT * FROM nonprofit_candidates WHERE user_email = ? AND opportunity_id = ? AND dedupe_key = ?",
    )
    .get(input.userEmail, input.opportunityId, input.dedupeKey) as NonprofitCandidateRow;
  return rowToNonprofitCandidate(row);
}

export function listNonprofitCandidates(
  opportunityId: string,
  userEmail: string,
): NonprofitCandidateRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM nonprofit_candidates
       WHERE user_email = ? AND opportunity_id = ?
       ORDER BY relevance_score DESC, name ASC`,
    )
    .all(userEmail, opportunityId) as NonprofitCandidateRow[];
  return rows.map(rowToNonprofitCandidate);
}

export function getNonprofitCandidate(
  id: string,
  userEmail: string,
): NonprofitCandidateRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM nonprofit_candidates WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as NonprofitCandidateRow | undefined;
  return row ? rowToNonprofitCandidate(row) : null;
}

export function setNonprofitCandidateDisposition(
  id: string,
  userEmail: string,
  disposition: NonprofitDisposition,
): NonprofitCandidateRecord | null {
  if (!isNonprofitDisposition(disposition)) {
    throw new Error(`invalid nonprofit disposition: ${disposition}`);
  }
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE nonprofit_candidates SET disposition = @disposition, updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, disposition, now: Date.now() });
  if (res.changes === 0) return null;
  return getNonprofitCandidate(id, userEmail);
}

// Record that a candidate was promoted into a 4.3 contact (draft lead). Stores
// the link; does NOT send anything.
export function setNonprofitCandidatePromotedContact(
  id: string,
  userEmail: string,
  contactId: string,
): NonprofitCandidateRecord | null {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE nonprofit_candidates
       SET promoted_contact_id = @contact_id, disposition = 'already_contacted', updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, contact_id: contactId, now: Date.now() });
  if (res.changes === 0) return null;
  return getNonprofitCandidate(id, userEmail);
}

// --- Teaming notices (Item 5.2) --------------------------------------------

export type TeamingNoticeRecord = {
  id: string;
  userEmail: string;
  noticeId: string;
  title: string;
  agency: string | null;
  prime: string | null;
  noticeType: string;
  naics: string | null;
  description: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  setAside: string | null;
  url: string | null;
  source: string;
  fitScore: number;
  reasons: string[];
  knownPrime: boolean;
  disposition: TeamingDisposition;
  outreachDraft: string | null;
  createdAt: number;
  updatedAt: number;
};

type TeamingNoticeRow = {
  id: string;
  user_email: string;
  notice_id: string;
  title: string;
  agency: string | null;
  prime: string | null;
  notice_type: string;
  naics: string | null;
  description: string | null;
  posted_date: string | null;
  response_deadline: string | null;
  set_aside: string | null;
  url: string | null;
  source: string;
  fit_score: number;
  reasons_json: string;
  known_prime: number;
  disposition: string;
  outreach_draft: string | null;
  created_at: number;
  updated_at: number;
};

function rowToTeamingNotice(row: TeamingNoticeRow): TeamingNoticeRecord {
  return {
    id: row.id,
    userEmail: row.user_email,
    noticeId: row.notice_id,
    title: row.title,
    agency: row.agency,
    prime: row.prime,
    noticeType: row.notice_type,
    naics: row.naics,
    description: row.description,
    postedDate: row.posted_date,
    responseDeadline: row.response_deadline,
    setAside: row.set_aside,
    url: row.url,
    source: row.source,
    fitScore: row.fit_score,
    reasons: parseJsonArray(row.reasons_json),
    knownPrime: row.known_prime === 1,
    disposition: isTeamingDisposition(row.disposition) ? row.disposition : "new",
    outreachDraft: row.outreach_draft,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type UpsertTeamingNoticeInput = {
  userEmail: string;
  noticeId: string;
  title: string;
  agency: string | null;
  prime: string | null;
  noticeType: string;
  naics: string | null;
  description: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  setAside: string | null;
  url: string | null;
  source: string;
  fitScore: number;
  reasons: string[];
  knownPrime: boolean;
};

// Insert or refresh a teaming notice. On a re-scan (same user+notice_id) we
// update the discovery/scoring fields but DELIBERATELY leave disposition and
// outreach_draft untouched, so operator triage + saved drafts survive.
export function upsertTeamingNotice(input: UpsertTeamingNoticeInput): TeamingNoticeRecord {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO teaming_notices (
       id, user_email, notice_id, title, agency, prime, notice_type, naics,
       description, posted_date, response_deadline, set_aside, url, source,
       fit_score, reasons_json, known_prime, disposition, outreach_draft,
       created_at, updated_at
     ) VALUES (
       @id, @user_email, @notice_id, @title, @agency, @prime, @notice_type, @naics,
       @description, @posted_date, @response_deadline, @set_aside, @url, @source,
       @fit_score, @reasons_json, @known_prime, 'new', NULL,
       @now, @now
     )
     ON CONFLICT(user_email, notice_id) DO UPDATE SET
       title = excluded.title,
       agency = excluded.agency,
       prime = excluded.prime,
       notice_type = excluded.notice_type,
       naics = excluded.naics,
       description = excluded.description,
       posted_date = excluded.posted_date,
       response_deadline = excluded.response_deadline,
       set_aside = excluded.set_aside,
       url = excluded.url,
       source = excluded.source,
       fit_score = excluded.fit_score,
       reasons_json = excluded.reasons_json,
       known_prime = excluded.known_prime,
       updated_at = excluded.updated_at`,
  ).run({
    id,
    user_email: input.userEmail,
    notice_id: input.noticeId,
    title: input.title,
    agency: input.agency,
    prime: input.prime,
    notice_type: input.noticeType,
    naics: input.naics,
    description: input.description,
    posted_date: input.postedDate,
    response_deadline: input.responseDeadline,
    set_aside: input.setAside,
    url: input.url,
    source: input.source,
    fit_score: input.fitScore,
    reasons_json: JSON.stringify(input.reasons),
    known_prime: input.knownPrime ? 1 : 0,
    now,
  });
  const row = db
    .prepare("SELECT * FROM teaming_notices WHERE user_email = ? AND notice_id = ?")
    .get(input.userEmail, input.noticeId) as TeamingNoticeRow;
  return rowToTeamingNotice(row);
}

export function listTeamingNotices(userEmail: string): TeamingNoticeRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM teaming_notices
       WHERE user_email = ?
       ORDER BY fit_score DESC, updated_at DESC`,
    )
    .all(userEmail) as TeamingNoticeRow[];
  return rows.map(rowToTeamingNotice);
}

export function getTeamingNotice(id: string, userEmail: string): TeamingNoticeRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM teaming_notices WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as TeamingNoticeRow | undefined;
  return row ? rowToTeamingNotice(row) : null;
}

export function setTeamingNoticeDisposition(
  id: string,
  userEmail: string,
  disposition: TeamingDisposition,
): TeamingNoticeRecord | null {
  if (!isTeamingDisposition(disposition)) {
    throw new Error(`invalid teaming disposition: ${disposition}`);
  }
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE teaming_notices SET disposition = @disposition, updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, disposition, now: Date.now() });
  if (res.changes === 0) return null;
  return getTeamingNotice(id, userEmail);
}

// Save a 1.6-sanitized outreach DRAFT for a notice (NOTHING is sent). Moves a
// 'new'/'pursuing' notice to 'outreach_drafted'; leaves later states alone.
export function setTeamingNoticeOutreachDraft(
  id: string,
  userEmail: string,
  draft: string,
): TeamingNoticeRecord | null {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE teaming_notices
       SET outreach_draft = @draft,
           disposition = CASE WHEN disposition IN ('new','pursuing') THEN 'outreach_drafted' ELSE disposition END,
           updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, draft, now: Date.now() });
  if (res.changes === 0) return null;
  return getTeamingNotice(id, userEmail);
}

// Council Runs (Sprint 11 Track A)
export type CouncilRunRecord = {
  id: string;
  draftId: string;
  triggeredAt: number;
  triggerType: 'auto' | 'manual';
  agentOutputs: Record<string, unknown>;
  revisionPlan: Record<string, unknown> | null;
  preScore: number | null;
  postScore: number | null;
  status: 'running' | 'complete' | 'failed';
  humanDecision: 'submit' | 'needs_more_review' | 'reject' | null;
  humanDecisionAt: number | null;
  costUsd: number | null;
  createdAt: number;
  updatedAt: number;
};

type CouncilRunRow = {
  id: string;
  draft_id: string;
  triggered_at: number;
  trigger_type: string;
  agent_outputs: string;
  revision_plan: string | null;
  pre_score: number | null;
  post_score: number | null;
  status: string;
  human_decision: string | null;
  human_decision_at: number | null;
  cost_usd: number | null;
  created_at: number;
  updated_at: number;
};

function rowToCouncilRun(row: CouncilRunRow): CouncilRunRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    triggeredAt: row.triggered_at,
    triggerType: row.trigger_type as 'auto' | 'manual',
    agentOutputs: safeParse<Record<string, unknown>>(row.agent_outputs, {}),
    revisionPlan: row.revision_plan ? safeParse<Record<string, unknown>>(row.revision_plan, {}) : null,
    preScore: row.pre_score,
    postScore: row.post_score,
    status: row.status as 'running' | 'complete' | 'failed',
    humanDecision: row.human_decision as 'submit' | 'needs_more_review' | 'reject' | null,
    humanDecisionAt: row.human_decision_at,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateCouncilRunInput = {
  id?: string;
  draftId: string;
  triggerType: 'auto' | 'manual';
  preScore?: number | null;
};

export function createCouncilRun(input: CreateCouncilRunInput): string {
  const db = getDb();
  const id = input.id || crypto.randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO council_runs (
      id, draft_id, triggered_at, trigger_type, agent_outputs,
      pre_score, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.draftId,
    now,
    input.triggerType,
    JSON.stringify({}),
    input.preScore ?? null,
    'running',
    now,
    now
  );

  return id;
}

export function updateCouncilRun(id: string, updates: {
  agentOutputs?: Record<string, unknown>;
  revisionPlan?: Record<string, unknown> | null;
  postScore?: number | null;
  status?: 'running' | 'complete' | 'failed';
  costUsd?: number | null;
  humanDecision?: 'submit' | 'needs_more_review' | 'reject' | null;
  humanDecisionAt?: number | null;
}): boolean {
  const db = getDb();
  const now = Date.now();

  const setParts: string[] = [];
  const values: unknown[] = [];

  if (updates.agentOutputs !== undefined) {
    setParts.push('agent_outputs = ?');
    values.push(JSON.stringify(updates.agentOutputs));
  }
  if (updates.revisionPlan !== undefined) {
    setParts.push('revision_plan = ?');
    values.push(updates.revisionPlan ? JSON.stringify(updates.revisionPlan) : null);
  }
  if (updates.postScore !== undefined) {
    setParts.push('post_score = ?');
    values.push(updates.postScore);
  }
  if (updates.status !== undefined) {
    setParts.push('status = ?');
    values.push(updates.status);
  }
  if (updates.costUsd !== undefined) {
    setParts.push('cost_usd = ?');
    values.push(updates.costUsd);
  }
  if (updates.humanDecision !== undefined) {
    setParts.push('human_decision = ?');
    values.push(updates.humanDecision);
  }
  if (updates.humanDecisionAt !== undefined) {
    setParts.push('human_decision_at = ?');
    values.push(updates.humanDecisionAt);
  }

  if (setParts.length === 0) return false;

  setParts.push('updated_at = ?');
  values.push(now);
  values.push(id);

  const res = db.prepare(`
    UPDATE council_runs
    SET ${setParts.join(', ')}
    WHERE id = ?
  `).run(...values);

  return res.changes > 0;
}

export function getCouncilRun(id: string, userEmail: string): CouncilRunRecord | null {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT cr.* FROM council_runs cr
      JOIN drafts d ON d.id = cr.draft_id
      WHERE cr.id = ? AND d.user_email = ?
    `)
    .get(id, userEmail) as CouncilRunRow | undefined;
  return row ? rowToCouncilRun(row) : null;
}

export function listCouncilRunsForDraft(draftId: string, userEmail: string): CouncilRunRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT cr.* FROM council_runs cr
      JOIN drafts d ON d.id = cr.draft_id
      WHERE cr.draft_id = ? AND d.user_email = ?
      ORDER BY cr.triggered_at DESC
    `)
    .all(draftId, userEmail) as CouncilRunRow[];
  return rows.map(rowToCouncilRun);
}

export function getLatestCouncilRunForDraft(draftId: string, userEmail: string): CouncilRunRecord | null {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT cr.* FROM council_runs cr
      JOIN drafts d ON d.id = cr.draft_id
      WHERE cr.draft_id = ? AND d.user_email = ?
      ORDER BY cr.triggered_at DESC
      LIMIT 1
    `)
    .get(draftId, userEmail) as CouncilRunRow | undefined;
  return row ? rowToCouncilRun(row) : null;
}

// --- Micro Contracts (028) ---------------------------------------------------

export type MicroContractRecord = {
  id: string;
  userEmail: string;
  noticeId: string;
  solNumber: string | null;
  title: string;
  agency: string | null;
  noticeType: string;
  naics: string | null;
  description: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  setAside: string | null;
  /** Controlled set-aside vocabulary (migration 039, lib/set-aside.ts). */
  setAsideCanonical: SetAsideCanonical | null;
  url: string | null;
  source: string;
  disposition: MicroContractDisposition;
  responseDraft: string | null;
  /**
   * Layer-2 canonical counterpart (migration 040, R-1). Null = not linked,
   * the normal state — most staging rows never become canonical. States are
   * never copied across the link; conflicts are surfaced, not resolved.
   */
  fpOpportunityId: string | null;
  createdAt: number;
  updatedAt: number;
};

type MicroContractRow = {
  id: string;
  user_email: string;
  notice_id: string;
  sol_number: string | null;
  title: string;
  agency: string | null;
  notice_type: string;
  naics: string | null;
  description: string | null;
  posted_date: string | null;
  response_deadline: string | null;
  set_aside: string | null;
  set_aside_canonical: string | null;
  fp_opportunity_id: string | null;
  url: string | null;
  source: string;
  disposition: string;
  response_draft: string | null;
  created_at: number;
  updated_at: number;
};

function rowToMicroContract(row: MicroContractRow): MicroContractRecord {
  return {
    id: row.id,
    userEmail: row.user_email,
    noticeId: row.notice_id,
    solNumber: row.sol_number,
    title: row.title,
    agency: row.agency,
    noticeType: row.notice_type,
    naics: row.naics,
    description: row.description,
    postedDate: row.posted_date,
    responseDeadline: row.response_deadline,
    setAside: row.set_aside,
    setAsideCanonical: isSetAsideCanonical(row.set_aside_canonical) ? row.set_aside_canonical : null,
    url: row.url,
    source: row.source,
    disposition: isMicroContractDisposition(row.disposition) ? row.disposition : "new",
    fpOpportunityId: row.fp_opportunity_id ?? null,
    responseDraft: row.response_draft,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type UpsertMicroContractInput = {
  userEmail: string;
  noticeId: string;
  solNumber: string | null;
  title: string;
  agency: string | null;
  noticeType: string;
  naics: string | null;
  description: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  setAside: string | null;
  url: string | null;
};

export function upsertMicroContract(
  input: UpsertMicroContractInput,
): {
  record: MicroContractRecord;
  created: boolean;
  /**
   * Set when the notice matches a permanent-delete tombstone (migration 036).
   * NOTHING was written: `record` is a stand-in built from the tombstone and
   * `created` is false — so existing callers that only check `created` never
   * log events or set dispositions on it. Importers should count and report
   * these as skipped.
   */
  skippedDeleted?: boolean;
} {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();

  // Tombstone guard: a permanently deleted notice must never be recreated by
  // a sweep re-import — importers dedupe on notice_id, so without this a
  // deleted row would be back within one scan cycle.
  const tombstone = db
    .prepare(
      `SELECT * FROM deleted_opportunities
        WHERE source = 'micro'
          AND ((notice_id IS NOT NULL AND notice_id = @notice_id)
            OR (sol_number IS NOT NULL AND @sol_number IS NOT NULL AND sol_number = @sol_number))
        LIMIT 1`,
    )
    .get({ notice_id: input.noticeId, sol_number: input.solNumber }) as
    | { id: string; notice_id: string | null; sol_number: string | null; title: string; agency: string | null; reason: string | null; deleted_at: number; deleted_by: string }
    | undefined;
  if (tombstone) {
    return {
      record: {
        id: tombstone.id,
        userEmail: input.userEmail,
        noticeId: tombstone.notice_id ?? input.noticeId,
        solNumber: tombstone.sol_number,
        title: tombstone.title,
        agency: tombstone.agency,
        noticeType: input.noticeType,
        naics: null,
        description: tombstone.reason,
        postedDate: null,
        responseDeadline: null,
        setAside: null,
        setAsideCanonical: null,
        url: null,
        source: "sam_gov",
        disposition: "passed",
        responseDraft: null,
        fpOpportunityId: null,
        createdAt: Number(tombstone.deleted_at),
        updatedAt: Number(tombstone.deleted_at),
      },
      created: false,
      skippedDeleted: true,
    };
  }
  const existing = db
    .prepare("SELECT id FROM micro_contracts WHERE user_email = ? AND notice_id = ?")
    .get(input.userEmail, input.noticeId) as { id: string } | undefined;

  db.prepare(
    `INSERT INTO micro_contracts (
       id, user_email, notice_id, sol_number, title, agency, notice_type, naics,
       description, posted_date, response_deadline, set_aside, set_aside_canonical, url, source,
       disposition, response_draft, created_at, updated_at
     ) VALUES (
       @id, @user_email, @notice_id, @sol_number, @title, @agency, @notice_type, @naics,
       @description, @posted_date, @response_deadline, @set_aside, @set_aside_canonical, @url, 'sam_gov',
       'new', NULL, @now, @now
     )
     ON CONFLICT(user_email, notice_id) DO UPDATE SET
       sol_number = excluded.sol_number,
       title = excluded.title,
       agency = excluded.agency,
       notice_type = excluded.notice_type,
       naics = excluded.naics,
       description = excluded.description,
       posted_date = excluded.posted_date,
       response_deadline = excluded.response_deadline,
       set_aside = excluded.set_aside,
       set_aside_canonical = excluded.set_aside_canonical,
       url = excluded.url,
       updated_at = excluded.updated_at`,
  ).run({
    id,
    user_email: input.userEmail,
    notice_id: input.noticeId,
    sol_number: input.solNumber,
    title: input.title,
    agency: input.agency,
    notice_type: input.noticeType,
    naics: input.naics,
    description: input.description,
    posted_date: input.postedDate,
    response_deadline: input.responseDeadline,
    set_aside: input.setAside,
    // Canonical shadows raw at every write (migration 039); raw is untouched.
    set_aside_canonical: normaliseSetAside(input.setAside).canonical,
    url: input.url,
    now,
  });

  // R-1: attempt the staging->canonical link at ingest so new rows connect
  // without a manual pass. Link only when currently unlinked; an ambiguous
  // match links nothing (the linker script reports those); NO state is ever
  // copied across the link.
  const linkState = db
    .prepare("SELECT id, fp_opportunity_id FROM micro_contracts WHERE user_email = ? AND notice_id = ?")
    .get(input.userEmail, input.noticeId) as { id: string; fp_opportunity_id: string | null } | undefined;
  if (linkState && linkState.fp_opportunity_id == null) {
    const fpRows = db
      .prepare("SELECT id, notice_id AS noticeId, sol_number AS solNumber FROM fp_opportunities")
      .all() as IdentityRow[];
    const link = resolveLink({ noticeId: input.noticeId, solNumber: input.solNumber }, fpRows);
    if (link.kind === "match") {
      db.prepare("UPDATE micro_contracts SET fp_opportunity_id = ? WHERE id = ?").run(link.fpId, linkState.id);
    }
  }

  const row = db
    .prepare("SELECT * FROM micro_contracts WHERE user_email = ? AND notice_id = ?")
    .get(input.userEmail, input.noticeId) as MicroContractRow;
  return { record: rowToMicroContract(row), created: !existing };
}

export function listMicroContracts(userEmail: string): MicroContractRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM micro_contracts
       WHERE user_email = ?
       ORDER BY
         CASE WHEN response_deadline IS NOT NULL THEN 0 ELSE 1 END,
         response_deadline ASC,
         updated_at DESC`,
    )
    .all(userEmail) as MicroContractRow[];
  return rows.map(rowToMicroContract);
}

export function getMicroContract(id: string, userEmail: string): MicroContractRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM micro_contracts WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as MicroContractRow | undefined;
  return row ? rowToMicroContract(row) : null;
}

/**
 * Permanently delete a micro contract (migration 036 — the operator's decision;
 * there is no undo). Owner-scoped in the query. One transaction: write the
 * tombstone, remove the row. The tombstone keeps upsertMicroContract from
 * ever recreating the notice on a later sweep import.
 */
export function deleteMicroContract(
  id: string,
  userEmail: string,
  opts: { reason?: string | null; by: string },
): { id: string; noticeId: string; title: string } {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM micro_contracts WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as MicroContractRow | undefined;
  if (!row) throw new Error(`unknown micro contract id: ${id}`);
  // AnyDb does not expose .transaction() — raw BEGIN IMMEDIATE, like council.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO deleted_opportunities
         (id, source, notice_id, sol_number, title, agency, reason, deleted_at, deleted_by)
       VALUES (?, 'micro', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.notice_id, row.sol_number, row.title, row.agency, opts.reason ?? null, Date.now(), opts.by);
    db.prepare("DELETE FROM micro_contracts WHERE id = ?").run(row.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { id: row.id, noticeId: row.notice_id, title: row.title };
}

export function setMicroContractDisposition(
  id: string,
  userEmail: string,
  disposition: MicroContractDisposition,
): MicroContractRecord | null {
  if (!isMicroContractDisposition(disposition)) {
    throw new Error(`invalid micro contract disposition: ${disposition}`);
  }
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE micro_contracts SET disposition = @disposition, updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, disposition, now: Date.now() });
  if (res.changes === 0) return null;
  return getMicroContract(id, userEmail);
}

export function setMicroContractResponseDraft(
  id: string,
  userEmail: string,
  draft: string,
): MicroContractRecord | null {
  const db = getDb();
  const res = db
    .prepare(
      `UPDATE micro_contracts
       SET response_draft = @draft,
           disposition = CASE WHEN disposition IN ('new','reviewing') THEN 'drafting' ELSE disposition END,
           updated_at = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, draft, now: Date.now() });
  if (res.changes === 0) return null;
  return getMicroContract(id, userEmail);
}
