// Merge the forked Bid Board pipeline.db into GovScout's fp_opportunities.
//
// The two stores split-brained: ~/.openclaw/workspace/bid-board/data/
// pipeline.db kept receiving rows after data/govscout.db became canonical,
// leaving live federal opportunities invisible to GovScout. Reconcile rules:
//   - Bid Board-only rows   -> imported via upsertFpOpportunity (the typed
//                              path: validation + reopen guard, never raw
//                              SQL), plus an fp_event recording provenance
//   - shared rows           -> field by field: identical = no-op; Bid Board
//                              fills GovScout blanks (pure enrichment); both
//                              non-empty and different = CONFLICT, reported
//                              for the operator and never auto-resolved
//   - GovScout-only rows    -> untouched
// The Bid Board database is opened read-only and is never written.
//
// Idempotent: a second --apply run finds the imported rows by natural key,
// diffs them as identical, and changes nothing (events log on create only).
//
// Usage:
//   node --import tsx scripts/bidboard-merge.mts            # dry run (default)
//   node --import tsx scripts/bidboard-merge.mts --dry-run  # same, explicit
//   node --import tsx scripts/bidboard-merge.mts --apply    # perform writes

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  mapBidBoardRow,
  fromFpOpportunity,
  diffRow,
  buildImportInput,
  buildEnrichmentInput,
  type FieldConflict,
  type RawFpRow,
} from "../lib/bidboard-merge";
import {
  listFpOpportunities,
  upsertFpOpportunity,
  logFpEvent,
  findFpTombstone,
  type FpOpportunity,
} from "../lib/federal-pipeline";

const BB_DB_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "bid-board",
  "data",
  "pipeline.db",
);
const AUDIT_DIR = path.join(process.cwd(), "audit", "bidboard-merge");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((a) => a !== "--apply" && a !== "--dry-run");
if (unknown.length > 0) {
  console.error(`unknown arguments: ${unknown.join(" ")}`);
  console.error("usage: node --import tsx scripts/bidboard-merge.mts [--dry-run | --apply]");
  process.exit(1);
}
if (apply && args.includes("--dry-run")) {
  console.error("--dry-run and --apply are mutually exclusive");
  process.exit(1);
}

// Bid Board side: read-only, always. fileMustExist so a moved/renamed fork
// fails loudly instead of creating an empty database.
const bbDb = new Database(BB_DB_PATH, { readonly: true, fileMustExist: true });
const bbRaw = bbDb.prepare("SELECT * FROM fp_opportunities").all() as RawFpRow[];
bbDb.close();
const bbRows = bbRaw.map(mapBidBoardRow);

// GovScout side via the typed store (cwd must be the project root, like every
// other script here — lib/db.ts derives data/govscout.db from process.cwd()).
const gsOpps = listFpOpportunities({ limit: 1000 });
const byNotice = new Map<string, FpOpportunity>();
const bySol = new Map<string, FpOpportunity>();
for (const opp of gsOpps) {
  if (opp.noticeId) byNotice.set(opp.noticeId, opp);
  if (opp.solNumber && !bySol.has(opp.solNumber)) bySol.set(opp.solNumber, opp);
}

let imported = 0;
let enriched = 0;
let conflicted = 0;
let unchanged = 0;
let skipped = 0;
let skippedDeleted = 0;
const conflicts: FieldConflict[] = [];
const importedTitles: string[] = [];
const enrichedNotes: string[] = [];
const skippedNotes: string[] = [];
const matchedGsIds = new Set<string>();

for (const row of bbRows) {
  const match =
    (row.noticeId ? byNotice.get(row.noticeId) : undefined) ??
    (row.solNumber ? bySol.get(row.solNumber) : undefined);

  if (!match) {
    // Bid Board-only. A row with no natural key at all would re-import on
    // every run (upsert could never find it again) — skip and report instead.
    if (!row.noticeId && !row.solNumber) {
      skipped++;
      skippedNotes.push(`no natural key: "${row.title.slice(0, 60)}"`);
      continue;
    }
    if (!row.title) {
      skipped++;
      skippedNotes.push(`missing title: ${row.noticeId ?? row.solNumber}`);
      continue;
    }
    // Permanently deleted (migration 036): a tombstone means the operator removed
    // this opportunity and it must never be re-imported. Counted separately —
    // a silent drop here would look like the merge lost data.
    const tombstone = findFpTombstone(row.noticeId, row.solNumber);
    if (tombstone) {
      skippedDeleted++;
      skippedNotes.push(
        `deleted (tombstone ${new Date(tombstone.deletedAt).toISOString().slice(0, 10)} by ${tombstone.deletedBy}): "${row.title.slice(0, 50)}"`,
      );
      continue;
    }
    imported++;
    importedTitles.push(
      `${(row.solNumber ?? row.noticeId ?? "?").padEnd(24)} ${row.status.padEnd(14)} ${row.title.slice(0, 56)}`,
    );
    if (apply) {
      const { opp, created } = upsertFpOpportunity(buildImportInput(row));
      if (created) {
        logFpEvent(opp.id, "note", {
          source: "bidboard-merge",
          note: "imported from Bid Board pipeline.db during split-brain merge",
          bidboardDb: BB_DB_PATH,
          bidboardCreatedAt: row.createdAt,
          bidboardUpdatedAt: row.updatedAt,
        });
      }
    }
    continue;
  }

  if (matchedGsIds.has(match.id)) {
    // Two Bid Board rows resolved to the same GovScout row — do not guess.
    skipped++;
    skippedNotes.push(
      `second bid-board row also matches govscout ${match.solNumber ?? match.noticeId}: ${row.solNumber ?? row.noticeId}`,
    );
    continue;
  }
  matchedGsIds.add(match.id);

  const gsRow = fromFpOpportunity(match);
  const { enrich, conflicts: rowConflicts } = diffRow(gsRow, row);
  const enrichFields = Object.keys(enrich);

  if (rowConflicts.length > 0) {
    conflicted++;
    conflicts.push(...rowConflicts);
  }
  if (enrichFields.length > 0) {
    enriched++;
    enrichedNotes.push(
      `${(gsRow.solNumber ?? gsRow.noticeId ?? "?").padEnd(24)} +${enrichFields.join(", +")}`,
    );
    if (apply) {
      upsertFpOpportunity(buildEnrichmentInput(gsRow, enrich));
    }
  }
  if (rowConflicts.length === 0 && enrichFields.length === 0) {
    unchanged++;
  }
}

const govscoutOnly = gsOpps.filter((o) => !matchedGsIds.has(o.id)).length;

// Conflict report: exactly the adjudication shape the operator needs, plus noticeId
// for rows whose sol_number is null. Written to audit/ only on --apply — a dry
// run writes nothing and prints the same JSON to stdout instead.
const conflictPayload = conflicts.map((c) => ({
  solNumber: c.solNumber,
  noticeId: c.noticeId,
  field: c.field,
  govscout: c.govscout,
  bidboard: c.bidboard,
}));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const conflictPath = path.join(AUDIT_DIR, `conflicts-${stamp}.json`);

const mode = apply ? "APPLY" : "DRY RUN (no writes)";
console.log(`bid-board merge — ${mode}`);
console.log(`  bid board: ${bbRows.length} rows  (${BB_DB_PATH}, opened read-only)`);
console.log(`  govscout:  ${gsOpps.length} rows  (data/govscout.db)`);
console.log("");
console.log(`  imported:      ${imported}   (bid-board-only rows ${apply ? "created" : "that would be created"} via upsertFpOpportunity)`);
console.log(`  enriched:      ${enriched}   (shared rows where bid board fills govscout blanks)`);
console.log(`  conflicted:    ${conflicted}   (shared rows with ${conflicts.length} field conflict${conflicts.length === 1 ? "" : "s"} — NOT auto-resolved)`);
console.log(`  unchanged:     ${unchanged}   (shared rows already identical)`);
console.log(`  skipped:       ${skipped}`);
console.log(`  skipped (deleted): ${skippedDeleted}   (tombstoned by permanent delete — never re-imported)`);
console.log(`  govscout-only: ${govscoutOnly}   (untouched)`);
console.log("  (a shared row with both blanks-to-fill and conflicts counts in both enriched and conflicted)");

if (importedTitles.length > 0) {
  console.log(`\nimports (${importedTitles.length}):`);
  for (const line of importedTitles) console.log(`  ${line}`);
}
if (enrichedNotes.length > 0) {
  console.log(`\nenrichments (${enrichedNotes.length}):`);
  for (const line of enrichedNotes) console.log(`  ${line}`);
}
if (skippedNotes.length > 0) {
  console.log(`\nskipped (${skippedNotes.length}):`);
  for (const line of skippedNotes) console.log(`  ${line}`);
}

if (conflicts.length > 0) {
  if (apply) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(conflictPath, JSON.stringify(conflictPayload, null, 2) + "\n");
    console.log(`\nconflicts written for adjudication: ${conflictPath}`);
  } else {
    console.log(`\nconflicts (would be written to ${conflictPath} on --apply):`);
    console.log(JSON.stringify(conflictPayload, null, 2));
  }
} else {
  console.log("\nno field conflicts detected");
}

if (!apply) {
  console.log("\ndry run complete — nothing was written. Re-run with --apply to merge.");
}
