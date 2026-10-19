import fs from "fs";
import os from "os";
import path from "path";
import {
  SCOUT_CRON_JOBS,
  isScoutItemStatus,
  isScoutSource,
  type ScoutDigest,
  type ScoutItem,
  type ScoutItemStatus,
  type ScoutSource,
} from "./scouts-types";
import { getDb } from "./db";

// --- Cron run JSONL reader -------------------------------------------------

const CRON_RUNS_DIR = path.join(os.homedir(), ".openclaw", "cron", "runs");

type CronRunRecord = {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  model?: string;
};

function readJsonl(filePath: string): CronRunRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const out: CronRunRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CronRunRecord);
    } catch {
      // skip malformed lines — cron runs can be appended mid-flush
    }
  }
  return out;
}

// --- Markdown digest parser ------------------------------------------------

const URL_RE = /(https?:\/\/[^\s)\]]+)/i;
const NAICS_RE = /\b(\d{6})\b/;

// Buckets the item by sniffing the agency keywords in the item's text.
function classifySource(text: string): ScoutSource {
  const t = text.toLowerCase();
  if (/\bsamhsa\b|\bsm-\d{2}-\d{3}\b|\bti-\d{2}-\d{3}\b/.test(t)) return "samhsa";
  if (/\bhrsa\b|\brcorp\b/.test(t)) return "hrsa";
  if (/\bcdc\b|\bod2a\b|\bphig\b/.test(t)) return "cdc";
  if (/\bdoj\b|\bbja\b|\bdrug court\b|\breentry\b|\bsecond chance\b/.test(t)) return "doj";
  if (/\bhud\b|\bcdbg\b|\bhome\b|\bcontinuum of care\b/.test(t)) return "hud";
  if (/\bdol\b|\breo\b|\bpathway home\b|\bwioa\b/.test(t)) return "dol";
  if (/\bsba\b|\b8\(a\)\b/.test(t)) return "sba";
  if (/\bntia\b|\bbroadband\b/.test(t)) return "ntia";
  if (/\bfederal register\b/.test(t)) return "fed_register";
  if (/\bsam\.gov\b/.test(t)) return "sam_gov";
  if (/\bgrants\.gov\b/.test(t)) return "grants_gov";
  if (/\bmenendez\b|\bcpf\b|\bearmark\b/.test(t)) return "earmark";
  if (
    /\bnj |\bnew jersey\b|\bnjdoh\b|\bdmhas\b|\bnjcu\b|\bnjeda\b|\bstate of\b|\bnj\.gov\b/.test(t)
  )
    return "state";
  if (
    /\bharbor\b|\bmercer\b|\bmorris\b|\bcounty\b|\bcity of\b|\bmunicipal\b/.test(t)
  )
    return "county";
  if (
    /\brwjf\b|\bfoundation\b|\bbloomberg\b|\bschmidt\b|\bknight\b|\bgoogle\.org\b|\blisc\b/.test(
      t,
    )
  )
    return "foundation";
  return "other";
}

function extractAgency(text: string): string | null {
  const m = text.match(/\*\*Agency:\*\*\s*([^\n]+)/i);
  if (m) return m[1].trim();
  return null;
}

function extractDeadline(text: string): string | null {
  const m =
    text.match(/\*\*Deadline:?\*\*[^\n]+/i) ??
    text.match(/(?:deadline|due|closes?|close date)[:\s][^\n]*/i);
  if (!m) return null;
  return m[0].replace(/^\*\*deadline:?\*\*\s*/i, "").trim().slice(0, 200);
}

function extractFunding(text: string): string | null {
  const m =
    text.match(/\*\*(?:Range|Funding|Funding Range|Award)\:?\*\*\s*([^\n]+)/i) ??
    text.match(/\$[\d.,]+[KMB]?\s*(?:-\s*\$[\d.,]+[KMB]?)?(?:\/year)?/);
  if (!m) return null;
  return (m[1] ?? m[0]).trim().slice(0, 200);
}

function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[1].replace(/[)\].,;]+$/, "") : null;
}

function extractNaics(text: string): string | null {
  const m = text.match(/NAICS[^\n]*?(\d{6}(?:,\s*\d{6})*)/i) ?? text.match(NAICS_RE);
  return m ? m[1] : null;
}

// Parse the digest markdown into discrete item chunks. The Gov Scout cron
// emits items as either "### Heading" subsections or "**Name** — short" bullet
// blocks. We split on ### first, then walk each bullet under it. Falls back to
// a "one big item per digest" record if no headings are found.
type RawItem = { title: string; rawText: string };

function splitIntoItems(summary: string): RawItem[] {
  const out: RawItem[] = [];

  const h3Chunks = summary.split(/\n(?=###\s)/g);
  for (const chunk of h3Chunks) {
    const lines = chunk.split(/\n/);
    if (!lines.length) continue;
    const head = lines[0];
    if (!head.startsWith("###")) {
      // chunk before the first ### — try bullet-level extraction
      pushBulletItems(out, chunk);
      continue;
    }
    const heading = head.replace(/^###\s+/, "").trim();
    // Within an h3 chunk, look for **Name** ... lines as sub-items.
    // If none found, the whole h3 chunk is one item titled by the heading.
    const subBlocks = chunk.split(/\n(?=\*\*[^*\n]{3,}\*\*\s*[—–-])/g);
    if (subBlocks.length > 1) {
      for (const sb of subBlocks.slice(1)) {
        const title = (sb.match(/\*\*([^*\n]+)\*\*/) ?? [, ""])[1].trim();
        out.push({
          title: title || heading,
          rawText: sb.trim(),
        });
      }
      // Also keep any non-empty pre-bullet narrative as an item if substantial
      const intro = subBlocks[0].replace(head, "").trim();
      if (intro.length > 60) {
        out.push({ title: heading, rawText: intro });
      }
    } else {
      out.push({ title: heading, rawText: chunk.replace(head, "").trim() || chunk });
    }
  }

  // If we found nothing (no ### at all), try a flat bullet sweep.
  if (out.length === 0) pushBulletItems(out, summary);

  // Last resort: one big item.
  if (out.length === 0 && summary.trim().length > 0) {
    out.push({ title: "Digest", rawText: summary.trim() });
  }

  return out
    .map((it) => ({ title: it.title.slice(0, 240), rawText: it.rawText.trim() }))
    .filter((it) => it.title.length > 0 && it.rawText.length > 0);
}

function pushBulletItems(out: RawItem[], chunk: string) {
  const bulletBlocks = chunk.split(/\n(?=\*\*[^*\n]{3,}\*\*\s*[—–-])/g);
  for (const bb of bulletBlocks) {
    const m = bb.match(/\*\*([^*\n]+)\*\*\s*[—–-]\s*([^\n]+)/);
    if (m) {
      out.push({ title: `${m[1].trim()} — ${m[2].trim()}`.slice(0, 240), rawText: bb.trim() });
    }
  }
}

export type ParsedItem = {
  source: ScoutSource;
  title: string;
  agency: string | null;
  deadlineText: string | null;
  fundingText: string | null;
  naics: string | null;
  url: string | null;
  rawText: string;
};

export function parseDigestSummary(summary: string): ParsedItem[] {
  return splitIntoItems(summary).map((it) => ({
    source: classifySource(it.rawText),
    title: it.title,
    agency: extractAgency(it.rawText),
    deadlineText: extractDeadline(it.rawText),
    fundingText: extractFunding(it.rawText),
    naics: extractNaics(it.rawText),
    url: extractUrl(it.rawText),
    rawText: it.rawText,
  }));
}

// --- DB row helpers --------------------------------------------------------

type DigestRow = {
  id: string;
  user_email: string;
  cron_job_id: string;
  cron_session_id: string | null;
  source_label: string;
  ran_at_ms: number;
  status: string | null;
  summary: string;
  model: string | null;
  duration_ms: number | null;
  ingested_at_ms: number;
};

type ItemRow = {
  id: string;
  digest_id: string;
  user_email: string;
  source: string;
  title: string;
  agency: string | null;
  deadline_text: string | null;
  funding_text: string | null;
  naics: string | null;
  url: string | null;
  raw_text: string;
  status: string;
  pool_id: string | null;
  saved_opportunity_id: string | null;
  notes: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  score: number | null;
  score_rationale: string | null;
  scored_at: number | null;
};

function rowToDigest(row: DigestRow): ScoutDigest {
  return {
    id: row.id,
    userEmail: row.user_email,
    cronJobId: row.cron_job_id,
    cronSessionId: row.cron_session_id,
    sourceLabel: row.source_label,
    ranAtMs: row.ran_at_ms,
    status: row.status,
    summary: row.summary,
    model: row.model,
    durationMs: row.duration_ms,
    ingestedAtMs: row.ingested_at_ms,
  };
}

function rowToItem(row: ItemRow): ScoutItem {
  return {
    id: row.id,
    digestId: row.digest_id,
    userEmail: row.user_email,
    source: isScoutSource(row.source) ? (row.source as ScoutSource) : "other",
    title: row.title,
    agency: row.agency,
    deadlineText: row.deadline_text,
    fundingText: row.funding_text,
    naics: row.naics,
    url: row.url,
    rawText: row.raw_text,
    status: isScoutItemStatus(row.status) ? (row.status as ScoutItemStatus) : "new",
    poolId: row.pool_id,
    savedOpportunityId: row.saved_opportunity_id,
    notes: row.notes,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    score: row.score == null ? null : Number(row.score),
    scoreRationale: row.score_rationale,
    scoredAt: row.scored_at == null ? null : Number(row.scored_at),
  };
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- Ingestion -------------------------------------------------------------

export type IngestResult = {
  scanned: number;
  newDigests: number;
  newItems: number;
  skippedExisting: number;
  errors: string[];
  perJob: Array<{ cronJobId: string; label: string; runs: number; newDigests: number }>;
};

export function ingestDigestsForUser(userEmail: string): IngestResult {
  const db = getDb();
  const now = Date.now();
  const result: IngestResult = {
    scanned: 0,
    newDigests: 0,
    newItems: 0,
    skippedExisting: 0,
    errors: [],
    perJob: [],
  };

  const findExisting = db.prepare(
    "SELECT id FROM scout_digests WHERE user_email = ? AND cron_job_id = ? AND ran_at_ms = ?",
  );
  const insertDigest = db.prepare(`
    INSERT INTO scout_digests (
      id, user_email, cron_job_id, cron_session_id, source_label,
      ran_at_ms, status, summary, model, duration_ms, ingested_at_ms
    ) VALUES (
      @id, @user_email, @cron_job_id, @cron_session_id, @source_label,
      @ran_at_ms, @status, @summary, @model, @duration_ms, @ingested_at_ms
    )
  `);
  const insertItem = db.prepare(`
    INSERT INTO scout_items (
      id, digest_id, user_email, source, title, agency, deadline_text,
      funding_text, naics, url, raw_text, status, pool_id, saved_opportunity_id,
      notes, created_at_ms, updated_at_ms
    ) VALUES (
      @id, @digest_id, @user_email, @source, @title, @agency, @deadline_text,
      @funding_text, @naics, @url, @raw_text, @status, @pool_id, @saved_opportunity_id,
      @notes, @created_at_ms, @updated_at_ms
    )
  `);

  for (const job of SCOUT_CRON_JOBS) {
    const jobFile = path.join(CRON_RUNS_DIR, `${job.id}.jsonl`);
    const records = readJsonl(jobFile);
    const perJobStat = { cronJobId: job.id, label: job.label, runs: records.length, newDigests: 0 };

    for (const rec of records) {
      result.scanned += 1;
      if (rec.action !== "finished") continue;
      if (rec.status !== "ok") continue;
      const summary = rec.summary?.trim();
      if (!summary) continue;
      const ranAtMs = rec.runAtMs ?? rec.ts;
      if (typeof ranAtMs !== "number") continue;

      const existing = findExisting.get(userEmail, job.id, ranAtMs);
      if (existing) {
        result.skippedExisting += 1;
        continue;
      }

      const digestId = randomId();
      try {
        insertDigest.run({
          id: digestId,
          user_email: userEmail,
          cron_job_id: job.id,
          cron_session_id: rec.sessionId ?? null,
          source_label: job.label,
          ran_at_ms: ranAtMs,
          status: rec.status,
          summary,
          model: rec.model ?? null,
          duration_ms: rec.durationMs ?? null,
          ingested_at_ms: now,
        });
        result.newDigests += 1;
        perJobStat.newDigests += 1;

        const parsed = parseDigestSummary(summary);
        for (const p of parsed) {
          insertItem.run({
            id: randomId(),
            digest_id: digestId,
            user_email: userEmail,
            source: p.source,
            title: p.title,
            agency: p.agency,
            deadline_text: p.deadlineText,
            funding_text: p.fundingText,
            naics: p.naics,
            url: p.url,
            raw_text: p.rawText,
            status: "new",
            pool_id: null,
            saved_opportunity_id: null,
            notes: null,
            created_at_ms: now,
            updated_at_ms: now,
          });
          result.newItems += 1;
        }
      } catch (err) {
        result.errors.push(`${job.id}@${ranAtMs}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    result.perJob.push(perJobStat);
  }
  return result;
}

// --- Item 5.1: foundation grant ingestion ----------------------------------
//
// Foundation grants discovered by lib/foundation-sources flow through the SAME
// scouts pipeline (triage / score / promote) tagged source="foundation" — no
// separate UI lane. Each weekly scan creates one digest; items are de-duped at
// the item level (by title+url) so re-running the weekly cron is idempotent.

export const FOUNDATION_SCAN_CRON_JOB_ID = "foundation-weekly-scan";
export const FOUNDATION_SCAN_LABEL = "Foundation Grants Scan";

// Shape accepted by the ingester — matches lib/foundation-sources FoundationGrant
// without importing it here (keeps scouts.ts free of the sources layer).
export type FoundationIngestGrant = {
  funder: string;
  title: string;
  url: string | null;
  summary: string | null;
  deadlineText: string | null;
  focusAreas: string[];
  geography: string | null;
  fundingMin: string | null;
  fundingMax: string | null;
  applicationCycle: string | null;
  decisionTimeline: string | null;
  source: string;
};

export type FoundationIngestResult = {
  digestId: string | null;
  newItems: number;
  skippedDuplicates: number;
  sourcesUsed: string[];
};

// Item-level de-dupe key for a foundation grant already in scout_items.
function foundationItemKey(title: string, url: string | null): string {
  return `${title.trim().toLowerCase()}|${(url ?? "").trim().toLowerCase()}`;
}

function fundingTextOf(min: string | null, max: string | null): string | null {
  if (min && max) return `${min} – ${max}`;
  return min ?? max ?? null;
}

// Compact profile blob stored in notes so the foundation PROFILE data (cycle,
// decision timeline, geography, focus) survives into the pipeline.
function foundationNotes(g: FoundationIngestGrant): string {
  const parts: string[] = [`Funder: ${g.funder}`];
  if (g.geography) parts.push(`Geography: ${g.geography}`);
  if (g.focusAreas.length) parts.push(`Focus: ${g.focusAreas.join(", ")}`);
  if (g.applicationCycle) parts.push(`Cycle: ${g.applicationCycle}`);
  if (g.decisionTimeline) parts.push(`Decision: ${g.decisionTimeline}`);
  return parts.join(" · ");
}

export function ingestFoundationGrants(
  userEmail: string,
  grants: FoundationIngestGrant[],
  meta: { sourcesUsed?: string[]; ranAtMs?: number } = {},
): FoundationIngestResult {
  const db = getDb();
  const now = Date.now();
  const ranAtMs = meta.ranAtMs ?? now;
  const sourcesUsed = meta.sourcesUsed ?? [];

  // Existing foundation items for this user → de-dupe set.
  const existingRows = db
    .prepare("SELECT title, url FROM scout_items WHERE user_email = ? AND source = 'foundation'")
    .all(userEmail) as { title: string; url: string | null }[];
  const seen = new Set(existingRows.map((r) => foundationItemKey(r.title, r.url)));

  const fresh: FoundationIngestGrant[] = [];
  let skipped = 0;
  for (const g of grants) {
    const key = foundationItemKey(g.title, g.url);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    fresh.push(g);
  }

  if (fresh.length === 0) {
    return { digestId: null, newItems: 0, skippedDuplicates: skipped, sourcesUsed };
  }

  const digestId = randomId();
  const summary =
    `Foundation scan: ${fresh.length} new grant${fresh.length === 1 ? "" : "s"} ` +
    `from ${sourcesUsed.join(", ") || "foundation sources"}.`;

  const insertDigest = db.prepare(`
    INSERT INTO scout_digests (
      id, user_email, cron_job_id, cron_session_id, source_label,
      ran_at_ms, status, summary, model, duration_ms, ingested_at_ms
    ) VALUES (
      @id, @user_email, @cron_job_id, NULL, @source_label,
      @ran_at_ms, 'ok', @summary, NULL, NULL, @ingested_at_ms
    )
  `);
  const insertItem = db.prepare(`
    INSERT INTO scout_items (
      id, digest_id, user_email, source, title, agency, deadline_text,
      funding_text, naics, url, raw_text, status, pool_id, saved_opportunity_id,
      notes, created_at_ms, updated_at_ms
    ) VALUES (
      @id, @digest_id, @user_email, 'foundation', @title, @agency, @deadline_text,
      @funding_text, NULL, @url, @raw_text, 'new', NULL, NULL,
      @notes, @created_at_ms, @updated_at_ms
    )
  `);

  // AnyDb (the better-sqlite3 / libsql portability shim) does not expose the
  // better-sqlite3 `.transaction()` helper, so use raw BEGIN/COMMIT/ROLLBACK —
  // the same atomicity primitive the migration runner relies on.
  db.exec("BEGIN");
  try {
    insertDigest.run({
      id: digestId,
      user_email: userEmail,
      cron_job_id: FOUNDATION_SCAN_CRON_JOB_ID,
      source_label: FOUNDATION_SCAN_LABEL,
      ran_at_ms: ranAtMs,
      summary,
      ingested_at_ms: now,
    });
    for (const g of fresh) {
      const rawText = [g.title, g.funder, g.summary ?? "", g.focusAreas.join(" "), g.geography ?? ""]
        .filter(Boolean)
        .join(" — ");
      insertItem.run({
        id: randomId(),
        digest_id: digestId,
        user_email: userEmail,
        title: g.title,
        agency: g.funder,
        deadline_text: g.deadlineText,
        funding_text: fundingTextOf(g.fundingMin, g.fundingMax),
        url: g.url,
        raw_text: rawText,
        notes: foundationNotes(g),
        created_at_ms: now,
        updated_at_ms: now,
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return {
    digestId,
    newItems: fresh.length,
    skippedDuplicates: skipped,
    sourcesUsed,
  };
}

// --- Queries ---------------------------------------------------------------

export type ListDigestsFilters = {
  cronJobId?: string;
  limit?: number;
};

export type DigestWithCounts = ScoutDigest & {
  itemCount: number;
  interestedCount: number;
  newCount: number;
};

export function listDigests(userEmail: string, filters: ListDigestsFilters = {}): DigestWithCounts[] {
  const db = getDb();
  const where: string[] = ["d.user_email = @user_email"];
  const params: Record<string, unknown> = { user_email: userEmail };
  if (filters.cronJobId) {
    where.push("d.cron_job_id = @cron_job_id");
    params.cron_job_id = filters.cronJobId;
  }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const rows = db
    .prepare(
      `
      SELECT d.*,
        (SELECT COUNT(*) FROM scout_items i WHERE i.digest_id = d.id) AS item_count,
        (SELECT COUNT(*) FROM scout_items i WHERE i.digest_id = d.id AND i.status = 'interested') AS interested_count,
        (SELECT COUNT(*) FROM scout_items i WHERE i.digest_id = d.id AND i.status = 'new') AS new_count
      FROM scout_digests d
      WHERE ${where.join(" AND ")}
      ORDER BY d.ran_at_ms DESC
      LIMIT ${limit}
      `,
    )
    .all(params) as Array<DigestRow & { item_count: number; interested_count: number; new_count: number }>;
  return rows.map((r) => ({
    ...rowToDigest(r),
    itemCount: Number(r.item_count ?? 0),
    interestedCount: Number(r.interested_count ?? 0),
    newCount: Number(r.new_count ?? 0),
  }));
}

export function getDigest(id: string, userEmail: string): ScoutDigest | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM scout_digests WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as DigestRow | undefined;
  return row ? rowToDigest(row) : null;
}

export function listItemsForDigest(digestId: string, userEmail: string): ScoutItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM scout_items WHERE digest_id = ? AND user_email = ? ORDER BY id ASC",
    )
    .all(digestId, userEmail) as ItemRow[];
  return rows.map(rowToItem);
}

export function getItem(id: string, userEmail: string): ScoutItem | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM scout_items WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as ItemRow | undefined;
  return row ? rowToItem(row) : null;
}

export type UpdateItemInput = {
  status?: ScoutItemStatus;
  poolId?: string | null;
  savedOpportunityId?: string | null;
  notes?: string | null;
};

export function updateItem(id: string, userEmail: string, patch: UpdateItemInput): ScoutItem | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM scout_items WHERE id = ? AND user_email = ?")
    .get(id, userEmail) as ItemRow | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.status !== undefined) {
    fields.push("status = @status");
    params.status = isScoutItemStatus(patch.status) ? patch.status : existing.status;
  }
  if (patch.poolId !== undefined) {
    fields.push("pool_id = @pool_id");
    params.pool_id = patch.poolId;
  }
  if (patch.savedOpportunityId !== undefined) {
    fields.push("saved_opportunity_id = @saved_opportunity_id");
    params.saved_opportunity_id = patch.savedOpportunityId;
  }
  if (patch.notes !== undefined) {
    fields.push("notes = @notes");
    params.notes = patch.notes;
  }
  if (fields.length === 0) return rowToItem(existing);
  fields.push("updated_at_ms = @updated_at_ms");
  params.updated_at_ms = Date.now();
  db.prepare(`UPDATE scout_items SET ${fields.join(", ")} WHERE id = @id`).run(params);
  const row = db.prepare("SELECT * FROM scout_items WHERE id = ?").get(id) as ItemRow;
  return rowToItem(row);
}

// Filter items across digests for the list-everything view.
export type ListAllItemsFilters = {
  status?: ScoutItemStatus | "all";
  source?: ScoutSource | "all";
  q?: string;
  limit?: number;
  // A1: sort by fit score DESC, unscored last. Default off (preserves prior
  // recency sort) so existing callers don't change behavior.
  orderBy?: "recent" | "score";
};

export function listAllItems(userEmail: string, filters: ListAllItemsFilters = {}): ScoutItem[] {
  const db = getDb();
  const where: string[] = ["user_email = @user_email"];
  const params: Record<string, unknown> = { user_email: userEmail };
  if (filters.status && filters.status !== "all" && isScoutItemStatus(filters.status)) {
    where.push("status = @status");
    params.status = filters.status;
  }
  if (filters.source && filters.source !== "all" && isScoutSource(filters.source)) {
    where.push("source = @source");
    params.source = filters.source;
  }
  if (filters.q && filters.q.trim()) {
    where.push(`(
      LOWER(COALESCE(title, '')) LIKE @q
      OR LOWER(COALESCE(agency, '')) LIKE @q
      OR LOWER(COALESCE(raw_text, '')) LIKE @q
      OR LOWER(COALESCE(notes, '')) LIKE @q
    )`);
    params.q = `%${filters.q.trim().toLowerCase()}%`;
  }
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const order =
    filters.orderBy === "score"
      ? "score DESC NULLS LAST, created_at_ms DESC"
      : "created_at_ms DESC";
  const rows = db
    .prepare(
      `SELECT * FROM scout_items WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
    )
    .all(params) as ItemRow[];
  return rows.map(rowToItem);
}

// A1: write a single scored item back to the DB. Returns the updated row.
export function setItemScore(
  id: string,
  userEmail: string,
  score: number,
  rationale: string,
): ScoutItem | null {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE scout_items
       SET score = @score, score_rationale = @rationale, scored_at = @now, updated_at_ms = @now
       WHERE id = @id AND user_email = @user_email`,
    )
    .run({ id, user_email: userEmail, score, rationale, now });
  if (result.changes === 0) return null;
  const row = db
    .prepare("SELECT * FROM scout_items WHERE id = ?")
    .get(id) as ItemRow | undefined;
  return row ? rowToItem(row) : null;
}

// A1: list items pending scoring (score IS NULL) up to a cap. Used by the
// /api/scouts/score-batch on-demand endpoint.
export function listUnscoredItems(userEmail: string, cap = 50): ScoutItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM scout_items
       WHERE user_email = ? AND score IS NULL
       ORDER BY created_at_ms DESC
       LIMIT ?`,
    )
    .all(userEmail, Math.min(Math.max(cap, 1), 50)) as ItemRow[];
  return rows.map(rowToItem);
}
