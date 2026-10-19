-- Sprint 4: Foundations — manually curated non-government grant sources.
-- Lives separate from scout_items (which come from the daily cron digest)
-- but surfaces alongside them on /scouts as a filterable section.
CREATE TABLE IF NOT EXISTS foundations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  source_label TEXT NOT NULL,    -- e.g. "RWJF", "Kresge"
  title TEXT NOT NULL,
  url TEXT,
  deadline_text TEXT,
  deadline_date TEXT,            -- ISO yyyy-mm-dd if known
  funding_min TEXT,
  funding_max TEXT,
  focus_area TEXT,
  geography TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed | won | lost | declined
  source_kind TEXT NOT NULL DEFAULT 'foundation'  -- foundation | corporate | family_office
);
CREATE INDEX IF NOT EXISTS idx_foundations_user ON foundations(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_foundations_source ON foundations(source_label);
CREATE INDEX IF NOT EXISTS idx_foundations_status ON foundations(status);
