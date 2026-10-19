-- Sprint 9 Track B: Activity Feed — extend activity_log so daily watchers
-- (Harbor, federal awards, SAM.gov, USAspending, behavioral-health, foundations)
-- can dual-write structured events alongside the existing 22-type action taxonomy.
-- Old rows keep working — every new column is nullable (except needs_review which
-- defaults to 0). The original action_type/actor/summary fields are still populated
-- so the legacy page rendering stays back-compatible.
--
-- SQLite limitation: one column per ALTER TABLE statement.

ALTER TABLE activity_log ADD COLUMN source TEXT;
ALTER TABLE activity_log ADD COLUMN severity TEXT;
ALTER TABLE activity_log ADD COLUMN event_type_extended TEXT;
ALTER TABLE activity_log ADD COLUMN new_items_count INTEGER;
ALTER TABLE activity_log ADD COLUMN errors_count INTEGER;
ALTER TABLE activity_log ADD COLUMN needs_review INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source);
CREATE INDEX IF NOT EXISTS idx_activity_severity ON activity_log(severity);
