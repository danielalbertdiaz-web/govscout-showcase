-- Sprint 4: Named draft snapshots — distinct from the existing draft_versions
-- table (which logs every section streaming write). Snapshots are the explicit
-- "Save version" full captures with a user-provided note.
CREATE TABLE IF NOT EXISTS draft_snapshots (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  snapshot_no INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT,
  title TEXT NOT NULL,
  business TEXT NOT NULL,
  naics TEXT NOT NULL,
  opportunity TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  structured_json TEXT,
  sections_json TEXT NOT NULL,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_draft ON draft_snapshots(draft_id, snapshot_no DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON draft_snapshots(user_email, created_at DESC);
