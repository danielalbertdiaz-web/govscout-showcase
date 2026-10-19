/**
 * G4 — stale-data cleanup (operator-authorized 2026-06-09: "Clear old items and
 * old searches that are not relevant").
 *
 * Run: node --import tsx scripts/cleanup-stale.mts            (DRY RUN — prints what would change)
 *      node --import tsx scripts/cleanup-stale.mts --apply    (actually applies)
 *
 * Philosophy: PRESERVE learning value, remove noise.
 *  1. Saved opportunities whose deadline has passed with NO disposition →
 *     set disposition 'expired_no_action' (terminal taxonomy already exists;
 *     feeds the win/loss calibration instead of vanishing).
 *  2. Scout items still 'new'/untriaged on digests older than 30 days →
 *     mark dismissed (status flip, not delete).
 *  3. Obvious test/dummy records (title/name LIKE '%test%' etc.) → DELETE,
 *     each printed before removal.
 * Nothing else is touched. Drafts, pools, partners, decisions, activity are
 * never auto-deleted.
 */

import Database from "better-sqlite3";
import path from "path";

const APPLY = process.argv.includes("--apply");
const DB_PATH = path.join(process.cwd(), "data", "govscout.db");
const db = new Database(DB_PATH);

const tables = new Set(
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  ),
);
console.log(`\n=== stale-data cleanup ${APPLY ? "(APPLY)" : "(dry run)"} — ${DB_PATH} ===`);

// ---- 1. Expired, never-pursued opportunities → expired_no_action ----------
if (tables.has("saved_opportunities")) {
  const rows = db
    .prepare(
      `SELECT id, title, deadline FROM saved_opportunities
       WHERE (disposition IS NULL OR disposition = '')
         AND deadline IS NOT NULL AND deadline != ''`,
    )
    .all() as { id: string; title: string; deadline: string }[];
  const expired = rows.filter((r) => {
    const t = Date.parse(r.deadline);
    return Number.isFinite(t) && t < Date.now();
  });
  console.log(`\n[1] expired un-dispositioned opportunities: ${expired.length}`);
  for (const r of expired.slice(0, 15)) console.log(`    - ${r.title.slice(0, 70)} (deadline ${r.deadline})`);
  if (expired.length > 15) console.log(`    … and ${expired.length - 15} more`);
  if (APPLY && expired.length) {
    const stmt = db.prepare(
      `UPDATE saved_opportunities
       SET disposition = 'expired_no_action', disposition_note = 'auto: deadline passed with no action (G4 cleanup)', disposition_at = ?
       WHERE id = ?`,
    );
    for (const r of expired) stmt.run(Date.now(), r.id);
    console.log(`    → dispositioned ${expired.length} as expired_no_action`);
  }
}

// ---- 2. Stale untriaged scout items → dismissed ----------------------------
// Schema introspected defensively: find the items table + a status-ish column.
const scoutTable = ["scout_items", "scout_digest_items"].find((t) => tables.has(t));
if (scoutTable) {
  const cols = (db.prepare(`PRAGMA table_info(${scoutTable})`).all() as { name: string }[]).map((c) => c.name);
  const statusCol = ["status", "disposition", "triage"].find((c) => cols.includes(c));
  const tsCol = ["created_at", "ingested_at", "ran_at"].find((c) => cols.includes(c));
  if (statusCol && tsCol) {
    const cutoff = Date.now() - 30 * 86_400_000;
    const stale = db
      .prepare(
        `SELECT COUNT(*) c FROM ${scoutTable}
         WHERE ${statusCol} IN ('new','untriaged','open') AND ${tsCol} < ?`,
      )
      .get(cutoff) as { c: number };
    console.log(`\n[2] scout items untriaged >30d (${scoutTable}.${statusCol}): ${stale.c}`);
    if (APPLY && stale.c) {
      db.prepare(
        `UPDATE ${scoutTable} SET ${statusCol} = 'dismissed'
         WHERE ${statusCol} IN ('new','untriaged','open') AND ${tsCol} < ?`,
      ).run(cutoff);
      console.log(`    → dismissed ${stale.c}`);
    }
  } else {
    console.log(`\n[2] ${scoutTable}: no recognizable status/timestamp columns — skipped (manual review)`);
  }
} else {
  console.log(`\n[2] no scout items table found — skipped`);
}

// ---- 3. Obvious test/dummy records → delete (printed first) ----------------
const dummyTargets: Array<{ table: string; nameCol: string }> = [
  { table: "saved_opportunities", nameCol: "title" },
  { table: "drafts", nameCol: "title" },
  { table: "funding_pools", nameCol: "name" },
];
for (const t of dummyTargets) {
  if (!tables.has(t.table)) continue;
  const rows = db
    .prepare(
      `SELECT id, ${t.nameCol} AS nm FROM ${t.table}
       WHERE LOWER(${t.nameCol}) LIKE '%test%' OR LOWER(${t.nameCol}) LIKE '%dummy%' OR LOWER(${t.nameCol}) LIKE '%sample %'`,
    )
    .all() as { id: string; nm: string }[];
  console.log(`\n[3] ${t.table} test/dummy candidates: ${rows.length}`);
  for (const r of rows) console.log(`    - ${r.nm.slice(0, 70)} (${r.id})`);
  if (APPLY && rows.length) {
    const del = db.prepare(`DELETE FROM ${t.table} WHERE id = ?`);
    for (const r of rows) del.run(r.id);
    console.log(`    → deleted ${rows.length}`);
  }
}

console.log(`\n${APPLY ? "applied." : "dry run only — re-run with --apply to make changes."}\n`);
db.close();
