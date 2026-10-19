-- Soft delete for the Bid Board (2026-07-31). Production data is never
-- destroyed: "delete" on /bid-board sets archived_at, the default list
-- excludes archived rows, and restore clears the marker. The fp_events
-- trail records both directions.

ALTER TABLE fp_opportunities ADD COLUMN archived_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_fp_opps_archived ON fp_opportunities(archived_at);
