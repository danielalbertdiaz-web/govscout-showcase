// Link Layer-1 staging rows (micro_contracts) to their Layer-2 canonical
// counterpart (fp_opportunities) — routing matrix R-1, phase 1.
//
// LINK and SURFACE only. State is never copied between the tables and
// conflicts are never auto-resolved: every disagreement is two human/agent
// decisions, and this script's job is to put them side by side for the operator —
// same discipline as bidboard-merge (82 conflicts surfaced, none adjudicated).
//
// Idempotent: links are written only when the resolved value differs from the
// stored one, so a second --apply run changes nothing and reports the same
// conflicts.
//
// Usage:
//   node --import tsx scripts/link-opportunities.mts            # dry run (default)
//   node --import tsx scripts/link-opportunities.mts --dry-run  # same, explicit
//   node --import tsx scripts/link-opportunities.mts --apply    # write links + conflict report

import fs from "node:fs";
import path from "node:path";
import { getDb } from "../lib/db";
import {
  linkCandidates,
  matchKey,
  statesConflict,
  type IdentityRow,
} from "../lib/opportunity-identity";

const AUDIT_DIR = path.join(process.cwd(), "audit", "opportunity-conflicts");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((a) => a !== "--apply" && a !== "--dry-run");
if (unknown.length > 0) {
  console.error(`unknown arguments: ${unknown.join(" ")}`);
  console.error("usage: node --import tsx scripts/link-opportunities.mts [--dry-run | --apply]");
  process.exit(1);
}
if (apply && args.includes("--dry-run")) {
  console.error("--dry-run and --apply are mutually exclusive");
  process.exit(1);
}

type MicroRow = IdentityRow & { title: string; disposition: string; fpOpportunityId: string | null };
type FpRow = IdentityRow & { title: string; status: string };

const db = getDb();
const microRows = db
  .prepare(
    `SELECT id, notice_id AS noticeId, sol_number AS solNumber, title, disposition,
            fp_opportunity_id AS fpOpportunityId
       FROM micro_contracts`,
  )
  .all() as MicroRow[];
const fpRows = db
  .prepare(`SELECT id, notice_id AS noticeId, sol_number AS solNumber, title, status FROM fp_opportunities`)
  .all() as FpRow[];
const fpById = new Map(fpRows.map((r) => [r.id, r]));

const { links, ambiguous } = linkCandidates(microRows, fpRows);
const microById = new Map(microRows.map((r) => [r.id, r]));

let newLinks = 0;
let alreadyLinked = 0;
let relinked = 0;
const conflicts: Array<{
  matchKey: { notice: string | null; sol: string | null };
  matchedOn: string;
  micro: { id: string; title: string; disposition: string };
  fp: { id: string; title: string; status: string };
}> = [];

for (const link of links) {
  const micro = microById.get(link.microId)!;
  const fp = fpById.get(link.fpId)!;

  if (micro.fpOpportunityId === link.fpId) alreadyLinked++;
  else if (micro.fpOpportunityId != null) relinked++; // stored link disagrees with resolver
  else newLinks++;

  if (statesConflict(fp.status, micro.disposition)) {
    conflicts.push({
      matchKey: matchKey(micro.noticeId, micro.solNumber),
      matchedOn: link.matchedOn,
      micro: { id: micro.id, title: micro.title, disposition: micro.disposition },
      fp: { id: fp.id, title: fp.title, status: fp.status },
    });
  }
}

const unlinked = microRows.length - links.length - ambiguous.length;

const mode = apply ? "APPLY" : "DRY RUN (no writes)";
console.log(`opportunity linker — ${mode}`);
console.log(`  staging (micro_contracts): ${microRows.length} rows`);
console.log(`  canonical (fp_opportunities): ${fpRows.length} rows`);
console.log("");
console.log(`  linked:          ${links.length}   (${newLinks} new, ${alreadyLinked} already linked, ${relinked} stored link disagrees with resolver)`);
console.log(`  ambiguous:       ${ambiguous.length}   (NOT linked — needs a human)`);
console.log(`  unlinked:        ${unlinked}   (no canonical counterpart — the normal state)`);
console.log(`  state conflicts: ${conflicts.length}   (linked pairs whose states disagree — surfaced, never auto-resolved)`);

if (ambiguous.length > 0) {
  console.log(`\nambiguous (${ambiguous.length}):`);
  for (const a of ambiguous) {
    const m = microById.get(a.microId)!;
    console.log(`  ${m.id}  "${m.title.slice(0, 50)}" — ${a.reason}`);
  }
}

if (conflicts.length > 0) {
  console.log(`\nstate conflicts (${conflicts.length}):`);
  for (const c of conflicts) {
    console.log(
      `  [${c.matchedOn}] ${c.matchKey.notice ?? c.matchKey.sol}\n` +
        `    fp:    ${c.fp.status.padEnd(14)} "${c.fp.title.slice(0, 56)}"\n` +
        `    micro: ${c.micro.disposition.padEnd(14)} "${c.micro.title.slice(0, 56)}"`,
    );
  }
} else {
  console.log("\nno state conflicts among linked pairs");
}

if (apply) {
  const stmt = db.prepare("UPDATE micro_contracts SET fp_opportunity_id = ? WHERE id = ?");
  db.exec("BEGIN IMMEDIATE");
  try {
    let written = 0;
    for (const link of links) {
      const micro = microById.get(link.microId)!;
      if (micro.fpOpportunityId !== link.fpId) {
        stmt.run(link.fpId, link.microId);
        written++;
      }
    }
    db.exec("COMMIT");
    console.log(`\nwrote ${written} link(s)`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const reportPath = path.join(AUDIT_DIR, `conflicts-${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ links: links.length, ambiguous, conflicts }, null, 2) + "\n");
  console.log(`conflict report written for adjudication: ${reportPath}`);
} else {
  console.log("\ndry run complete — nothing was written. Re-run with --apply to link.");
}
