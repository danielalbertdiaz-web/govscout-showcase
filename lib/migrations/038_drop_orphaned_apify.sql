-- Drop the orphaned Apify tables (2026-08-04, the operator-approved cleanup).
--
-- apify_runs and apify_daily_budget existed in production with ZERO rows and
-- ZERO references: no migration ever created them (they predate the runner),
-- and a full-tree search finds no reader or writer of either name — verified
-- again immediately before this migration was written. They are residue of a
-- removed feature and the reason "which tables are real?" was hard to answer.
--
-- Scope notes, recorded so the next reader has the full picture:
--   - Apify itself is NOT_VERIFIED: no live auth/terms/cost probe has been
--     done against the service.
--   - The Apify CODE is not all dead and is deliberately untouched here:
--     lib/apify.ts, lib/sources/apify-watcher.ts, the /api/scouts/apify-run
--     route, and scripts/{crawl,probe}-apify.mts remain in the tree, and
--     lib/settlement-scan.ts imports the watcher. That path writes
--     scout_digests / scout_items — never these tables.
--   - If the Apify lane is ever revived and needs run/budget bookkeeping, it
--     gets a proper migration; do not resurrect these ghosts by hand.
--
-- Their indexes (idx_apify_runs_*, idx_apify_budget_user_day) drop with the
-- tables. Fresh databases never had them — IF EXISTS makes this a no-op there.

DROP TABLE IF EXISTS apify_runs;
DROP TABLE IF EXISTS apify_daily_budget;
