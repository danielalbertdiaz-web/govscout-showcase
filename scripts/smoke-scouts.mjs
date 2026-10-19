// Sprint 2 smoke test — exercises the scouts ingest + parser pipeline directly
// against the live cron JSONL. Run with:
//   pnpm exec tsx scripts/smoke-scouts.mjs
// or:
//   node --import tsx scripts/smoke-scouts.mjs
//
// This bypasses HTTP/auth and tests the storage path that the /api/scouts/ingest
// route depends on. The HTTP smoke that follows verifies the UI wiring.

import { ingestDigestsForUser, listDigests, listItemsForDigest, parseDigestSummary } from "../lib/scouts.ts";
import { getDb } from "../lib/db.ts";

const USER = "hello@govscout.ai";

console.log("=== Sprint 2 smoke: scouts ingest + parse ===");
console.log("user:", USER);

console.log("\n--- DB state before ---");
const db = getDb();
console.log("user_version:", db.prepare("PRAGMA user_version").get());
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'scout%'")
  .all();
console.log("scout tables:", tables);
console.log("digest count:", db.prepare("SELECT COUNT(*) AS n FROM scout_digests").get());

console.log("\n--- ingest ---");
const result = ingestDigestsForUser(USER);
console.log("ingest summary:", {
  scanned: result.scanned,
  newDigests: result.newDigests,
  newItems: result.newItems,
  skippedExisting: result.skippedExisting,
  errors: result.errors.length,
});
console.log("per job:", result.perJob);

console.log("\n--- listDigests (top 5) ---");
const digests = listDigests(USER, { limit: 5 });
for (const d of digests) {
  console.log({
    id: d.id.slice(0, 8),
    label: d.sourceLabel,
    ranAt: new Date(d.ranAtMs).toISOString(),
    items: d.itemCount,
    new: d.newCount,
    interested: d.interestedCount,
  });
}

if (digests[0]) {
  console.log("\n--- items in top digest ---");
  const items = listItemsForDigest(digests[0].id, USER);
  for (const it of items.slice(0, 6)) {
    console.log({
      source: it.source,
      title: it.title.slice(0, 90),
      agency: it.agency,
      deadline: it.deadlineText?.slice(0, 80) ?? null,
      url: it.url?.slice(0, 80) ?? null,
      status: it.status,
    });
  }
  console.log(`  ...+${Math.max(0, items.length - 6)} more`);
}

console.log("\n--- parser unit check ---");
const sample = `## 🚨 URGENT - Next 30 Days

### FEDERAL

**SAMHSA TI-26-015** — Drug Courts SUD Treatment Expansion
- **Agency:** SAMHSA
- **Deadline:** Forecasted, NOFO pending
- **Range:** $400K max/year
- **NAICS:** 541611
- [Source](https://samhsa.gov/example)

**HRSA RCORP-Implementation FY2027** — Rural opioid
- **Agency:** HRSA
- **Deadline:** Q1 2027
`;
const parsed = parseDigestSummary(sample);
for (const p of parsed) {
  console.log(p);
}

console.log("\n=== smoke OK ===");
