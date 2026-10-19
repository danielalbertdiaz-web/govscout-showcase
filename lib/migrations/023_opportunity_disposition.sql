-- Migration 023: win/loss disposition on saved_opportunities (Item 3.1).
-- Terminal outcomes that close the loop on a pursued opportunity. Additive and
-- reversible: every column is nullable with no default, so existing rows are
-- untouched (NULL disposition == "not yet decided"). To roll back, drop the
-- three columns below; no data in pre-existing columns is rewritten.
--
-- SQLite allows only one ADD COLUMN per ALTER TABLE statement, hence three.
ALTER TABLE saved_opportunities ADD COLUMN disposition TEXT;
ALTER TABLE saved_opportunities ADD COLUMN disposition_note TEXT;
ALTER TABLE saved_opportunities ADD COLUMN disposition_at INTEGER;

-- Index the decided rows so the feedback loop (council enrichment + calibration)
-- can scan only opportunities that actually have an outcome.
CREATE INDEX IF NOT EXISTS idx_saved_opportunities_disposition
  ON saved_opportunities (user_email, disposition)
  WHERE disposition IS NOT NULL;
