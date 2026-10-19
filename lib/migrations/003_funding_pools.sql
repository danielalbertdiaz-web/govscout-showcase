-- Sprint 1 (pivot v2) — Funding Pools
-- Appropriated-but-undisbursed pools where money is sitting and deadlines
-- are forcing it out the door.

CREATE TABLE IF NOT EXISTS funding_pools (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  rank INTEGER,
  name TEXT NOT NULL,
  source TEXT,
  agency TEXT,
  jurisdiction TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  play_type TEXT,
  allocated_amount TEXT,
  unspent_amount TEXT,
  deadline_date TEXT,
  deadline_label TEXT,
  fit_summary TEXT,
  wedge TEXT,
  next_action TEXT,
  notes TEXT,
  tags_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pools_user ON funding_pools(user_email);
CREATE INDEX IF NOT EXISTS idx_pools_status ON funding_pools(status);
CREATE INDEX IF NOT EXISTS idx_pools_deadline ON funding_pools(deadline_date);
CREATE INDEX IF NOT EXISTS idx_pools_updated ON funding_pools(updated_at DESC);

-- Link drafts to a funding pool (mirror of NOFO link from migration 002).
-- Nullable so existing drafts continue to work; ON DELETE SET NULL so
-- removing a pool record doesn't cascade-kill drafts written against it.
ALTER TABLE drafts ADD COLUMN pool_id TEXT REFERENCES funding_pools(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_drafts_pool ON drafts(pool_id);
