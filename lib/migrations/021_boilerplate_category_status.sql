-- Item 2.1: Boilerplate library seeder support.
-- The library needs a category/tag for grouping and a review flag for blocks
-- that still carry placeholder tokens ([insert ...], [RESEARCH FLAG ...], TBD)
-- pulled from prior RFP submissions. Both columns are additive with safe
-- defaults, so existing rows keep working unchanged.
--
-- REVERSIBLE: to roll back on SQLite 3.35+ —
--   ALTER TABLE boilerplate_blocks DROP COLUMN status;
--   ALTER TABLE boilerplate_blocks DROP COLUMN category;
-- (No data is destroyed by the forward migration; rollback only removes the
--  two new columns. The migration runner tracks this as user_version = 21.)

ALTER TABLE boilerplate_blocks ADD COLUMN category TEXT;
ALTER TABLE boilerplate_blocks ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';

CREATE INDEX IF NOT EXISTS idx_bp_category ON boilerplate_blocks(category);
CREATE INDEX IF NOT EXISTS idx_bp_status ON boilerplate_blocks(status);
