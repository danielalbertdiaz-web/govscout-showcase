-- Priority flag for the Bid Board (2026-08-04). the operator marks an opportunity
-- "pay attention to this"; flagged rows sort first on the Bid Board, with the
-- existing deadline order preserved within each group.
--
-- Deliberately a nullable timestamp, NOT a boolean: when the call was made is
-- worth knowing, and NULL is an unambiguous "not flagged" that needs no
-- backfill (same shape as archived_at, migration 034). Written only through
-- setFpFlag in lib/federal-pipeline.ts, which logs the flagged/unflagged
-- fp event — never directly.
--
-- The deadline strips (upcomingDeadlines, the board's "Next 14 days") stay
-- strictly deadline-ordered on purpose: flagging is attention, not urgency,
-- and a flag must never hide what runs out first.

ALTER TABLE fp_opportunities ADD COLUMN flagged_at INTEGER;
