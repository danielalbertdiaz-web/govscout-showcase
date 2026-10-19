-- Sprint 5: Draft lifecycle status (per pivot brief: drafting → submitted → won/lost)
-- Default 'drafting' for existing rows.
ALTER TABLE drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'drafting';
ALTER TABLE drafts ADD COLUMN status_updated_at INTEGER;
ALTER TABLE drafts ADD COLUMN preflight_result_json TEXT;
ALTER TABLE drafts ADD COLUMN preflight_run_at INTEGER;
ALTER TABLE drafts ADD COLUMN submission_override_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
