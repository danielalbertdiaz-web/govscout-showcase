-- "Remind when reopens" for the grants workspaces (2026-08-26, the operator's
-- request). Many grant programs are cyclical — an annual NOFO whose deadline
-- passed is not dead, it is dormant. This marks a row as "watch for the next
-- cycle": the row leaves the go/no-go review queue, and the discovery crons
-- read the watch list each run and actively re-search those programs,
-- flagging REOPENED finds in the digest.
--
-- Nullable timestamp, not a boolean (the flagged_at model, migration 041):
-- when the watch was set is worth knowing, and NULL is an unambiguous "not
-- watched" needing no backfill. Written only through setFpReopenWatch in
-- lib/federal-pipeline.ts, which logs the flip on the event trail — never
-- directly.

ALTER TABLE fp_opportunities ADD COLUMN reopen_watch_at INTEGER;
