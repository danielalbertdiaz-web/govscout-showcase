/**
 * Sprint 9 Track B smoke — exercises ingestWatcherEvent + filtered
 * listRecentActivity against the real SQLite at data/govscout.db.
 *
 * Uses a synthetic source tag ("smoke_<ts>") to avoid polluting the operator's
 * real watcher event stream. Tests:
 *   1. Ingests 5 events covering every severity + a needs_review flag
 *   2. listRecentActivity with severities filter returns the expected counts
 *   3. listRecentActivity with sources filter scoped to our smoke tag returns 5
 *   4. listRecentActivity with needsReviewOnly returns just the flagged row
 *   5. ingestWatcherEvent payload round-trips correctly (detail JSON, counts)
 */

import { getDb } from "../lib/db";
import {
  ingestWatcherEvent,
  listRecentActivity,
  type Severity,
} from "../lib/activity";

const SMOKE_TAG = `smoke_${Date.now()}`;

function bar(s: string): void {
  process.stdout.write(`\n=== ${s} ===\n`);
}

function ok(label: string, cond: boolean, extra?: string): void {
  const tag = cond ? "PASS" : "FAIL";
  process.stdout.write(`  [${tag}] ${label}${extra ? ` — ${extra}` : ""}\n`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  getDb(); // triggers migration 017

  bar(`Sprint 9 Track B — activity feed ingestion smoke (${SMOKE_TAG})`);

  // We can't add SMOKE_TAG to the WATCHER_SOURCES enum at runtime — but we
  // CAN cast through the API for the smoke run. The validation runs in the
  // API route, not ingestWatcherEvent itself. So smoke uses real sources
  // (county_procurement, federal_awards, etc.) and uses the `detail.smokeTag`
  // field to scope reads.

  const e1 = ingestWatcherEvent({
    source: "county_procurement",
    severity: "info",
    eventType: "scan_complete",
    summary: `[${SMOKE_TAG}] harbor scan_complete (info, 0 new)`,
    newItemsCount: 0,
    errorsCount: 0,
    detail: { smokeTag: SMOKE_TAG, marker: "e1" },
  });

  const e2 = ingestWatcherEvent({
    source: "federal_awards",
    severity: "info",
    eventType: "new_postings",
    summary: `[${SMOKE_TAG}] federal_awards new_postings (info, 3 new)`,
    newItemsCount: 3,
    errorsCount: 0,
    detail: { smokeTag: SMOKE_TAG, marker: "e2" },
  });

  const e3 = ingestWatcherEvent({
    source: "sam_gov",
    severity: "warn",
    eventType: "expirations_detected",
    summary: `[${SMOKE_TAG}] sam_gov expirations_detected (warn, 5 expired)`,
    newItemsCount: 0,
    errorsCount: 0,
    needsReview: true,
    detail: { smokeTag: SMOKE_TAG, marker: "e3", expiredIds: ["a", "b", "c", "d", "e"] },
  });

  const e4 = ingestWatcherEvent({
    source: "county_procurement",
    severity: "critical",
    eventType: "scan_failure_protection",
    summary: `[${SMOKE_TAG}] harbor scan_failure_protection (critical) — 32 unexplained drops`,
    newItemsCount: 0,
    errorsCount: 1,
    needsReview: true,
    detail: { smokeTag: SMOKE_TAG, marker: "e4", unexplainedDrops: 32 },
  });

  const e5 = ingestWatcherEvent({
    source: "behavioral_health",
    severity: "info",
    eventType: "manual_override",
    summary: `[${SMOKE_TAG}] behavioral_health manual_override (info)`,
    detail: { smokeTag: SMOKE_TAG, marker: "e5" },
  });

  ok("e1 inserted", !!e1.id);
  ok("e2 inserted", !!e2.id);
  ok("e3 inserted", !!e3.id);
  ok("e4 inserted", !!e4.id);
  ok("e5 inserted", !!e5.id);

  const allSmokeIds = new Set([e1.id, e2.id, e3.id, e4.id, e5.id]);

  // --- T1: each event round-trips ---
  bar("T1 — fields round-trip on read");
  const recent = listRecentActivity({ limit: 500 });
  const ours = recent.filter((r) => allSmokeIds.has(r.id));
  ok("listRecentActivity returns all 5 smoke rows", ours.length === 5, `got=${ours.length}`);

  const round = ours.find((r) => r.id === e4.id);
  ok("e4 severity=critical", round?.severity === "critical", `got=${round?.severity ?? "null"}`);
  ok("e4 eventTypeExtended=scan_failure_protection", round?.eventTypeExtended === "scan_failure_protection");
  ok("e4 needsReview=true", round?.needsReview === true);
  ok("e4 errorsCount=1", round?.errorsCount === 1);
  const detail = round?.detail as Record<string, unknown> | null;
  ok("e4 detail.smokeTag round-tripped", detail?.smokeTag === SMOKE_TAG);
  ok("e4 actor=watcher", round?.actor === "watcher");
  ok("e4 action_type=watcher_scan_failure_protection", round?.actionType === "watcher_scan_failure_protection");

  // --- T2: severity filter ---
  bar("T2 — severity filter returns the right counts");
  const critOnly = listRecentActivity({ severities: ["critical"], limit: 500 }).filter(
    (r) => allSmokeIds.has(r.id),
  );
  ok("severities=[critical] returns exactly 1 smoke row", critOnly.length === 1, `got=${critOnly.length}`);

  const infoWarn = listRecentActivity({ severities: ["info", "warn"], limit: 500 }).filter(
    (r) => allSmokeIds.has(r.id),
  );
  ok("severities=[info,warn] returns 4 smoke rows", infoWarn.length === 4, `got=${infoWarn.length}`);

  // --- T3: source filter ---
  bar("T3 — source filter");
  const countyOnly = listRecentActivity({ sources: ["county_procurement"], limit: 500 }).filter(
    (r) => allSmokeIds.has(r.id),
  );
  ok("sources=[county_procurement] returns 2 smoke rows", countyOnly.length === 2, `got=${countyOnly.length}`);

  // --- T4: needsReview ---
  bar("T4 — needsReviewOnly returns just flagged rows");
  const reviewOnly = listRecentActivity({ needsReviewOnly: true, limit: 500 }).filter(
    (r) => allSmokeIds.has(r.id),
  );
  ok("needsReviewOnly returns 2 smoke rows", reviewOnly.length === 2, `got=${reviewOnly.length}`);
  const flaggedSeverities: Severity[] = reviewOnly
    .map((r) => r.severity)
    .filter((s): s is Severity => s !== null)
    .sort();
  ok(
    "flagged severities are [critical, warn]",
    JSON.stringify(flaggedSeverities) === JSON.stringify(["critical", "warn"]),
    `got=${JSON.stringify(flaggedSeverities)}`,
  );

  // --- T5: combined filter ---
  bar("T5 — combined source+severity filter");
  const countyCritical = listRecentActivity({
    sources: ["county_procurement"],
    severities: ["critical"],
    limit: 500,
  }).filter((r) => allSmokeIds.has(r.id));
  ok("county_procurement+critical returns 1 smoke row", countyCritical.length === 1, `got=${countyCritical.length}`);

  // --- T6: back-compat ---
  bar("T6 — back-compat: legacy listRecentActivity (no filters) still works");
  const legacyAll = listRecentActivity({ limit: 1000 });
  ok("legacy listRecentActivity returns >= 5 rows", legacyAll.length >= 5, `got=${legacyAll.length}`);

  process.stdout.write(`\nExit code: ${process.exitCode ?? 0}\n`);
}

main().catch((err) => {
  process.stderr.write(`smoke failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 2;
});
