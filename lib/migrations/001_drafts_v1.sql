-- Stage 1 + 2 schema baseline.
-- Drafts (workbench output) + per-section/full version log.

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  title TEXT NOT NULL,
  business TEXT NOT NULL,
  naics TEXT NOT NULL,
  opportunity TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  structured_json TEXT,
  sections_json TEXT NOT NULL,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_email);

CREATE TABLE IF NOT EXISTS draft_versions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  section TEXT,
  instruction TEXT,
  text TEXT NOT NULL,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_draft ON draft_versions(draft_id, created_at DESC);
