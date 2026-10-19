/**
 * Manual "scan now" for the underspend lane — runs the REAL scan and PERSISTS.
 * Run: node --import tsx scripts/scan-underspend.mts [ownerEmail]
 *
 * Mirrors GET /api/cron/underspend-scan but bypasses session auth for local
 * back-testing. Writes to the same on-disk better-sqlite3 DB the dev server
 * reads, so discovered pools appear at /pools on refresh. NOTHING is sent.
 */

import { runUnderspendScan } from "../lib/underspend-scan";
import { formatMoneyShort } from "../lib/underspend-sources/types";

const owner = process.argv[2]?.trim() || "owner@example.org";
console.log(`\n=== underspend scan → DB persist (owner: ${owner}) ===`);

const result = await runUnderspendScan(owner);

console.log(
  `sourcesUsed: ${result.sourcesUsed.join(", ") || "(none)"} | ` +
    `found: ${result.found} | ranked≥threshold: ${result.ranked} | ` +
    `created: ${result.created} | updated: ${result.updated}`,
);

console.log(`\n=== top persisted pools ===`);
for (const t of result.top) {
  console.log(`  [${t.score}] ${t.name} — ${t.unspent} unspent`);
}
console.log(`\n(formatMoneyShort sanity: ${formatMoneyShort(2_371_900_000)})`);
console.log("");
