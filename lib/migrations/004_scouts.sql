-- Sprint 2 (pivot v2) — Scouts pane.
-- Persists output of the existing scheduled scout cron(s) so the user can
-- browse historical digests, triage items, and promote items into funding
-- pools or saved opportunities.
--
-- C6 (no new crons): rows are filled by an on-demand /api/scouts/ingest POST
-- that reads ~/.openclaw/cron/runs/<cron_id>.jsonl. C10 (digest cron sacred):
-- read-only consumer — this schema only stores already-finished cron output.

CREATE TABLE IF NOT EXISTS scout_digests (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  cron_job_id TEXT NOT NULL,
  cron_session_id TEXT,
  source_label TEXT NOT NULL,
  ran_at_ms INTEGER NOT NULL,
  status TEXT,
  summary TEXT NOT NULL,
  model TEXT,
  duration_ms INTEGER,
  ingested_at_ms INTEGER NOT NULL,
  UNIQUE(cron_job_id, ran_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_scout_digests_user ON scout_digests(user_email);
CREATE INDEX IF NOT EXISTS idx_scout_digests_ran ON scout_digests(ran_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_scout_digests_job ON scout_digests(cron_job_id);

CREATE TABLE IF NOT EXISTS scout_items (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL REFERENCES scout_digests(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  agency TEXT,
  deadline_text TEXT,
  funding_text TEXT,
  naics TEXT,
  url TEXT,
  raw_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  pool_id TEXT REFERENCES funding_pools(id) ON DELETE SET NULL,
  saved_opportunity_id TEXT REFERENCES saved_opportunities(id) ON DELETE SET NULL,
  notes TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scout_items_user ON scout_items(user_email);
CREATE INDEX IF NOT EXISTS idx_scout_items_digest ON scout_items(digest_id);
CREATE INDEX IF NOT EXISTS idx_scout_items_status ON scout_items(status);
CREATE INDEX IF NOT EXISTS idx_scout_items_pool ON scout_items(pool_id);
CREATE INDEX IF NOT EXISTS idx_scout_items_source ON scout_items(source);
