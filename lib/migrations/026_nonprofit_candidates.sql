-- Item 4.5 — persisted non-profit scanner results.
--
-- The scanner discovers candidate partner non-profits for an opportunity (via
-- ProPublica/IRS-990 today, Candid later) and ranks them. We persist the
-- ranked shortlist so dispositions survive re-scans: a re-scan refreshes scores
-- but PRESERVES the user's disposition on rows it has already triaged.
--
-- Nothing here sends anything — promote_to_contact creates a 4.3 contact DRAFT.
--
-- disposition values: 'new' | 'already_contacted' | 'not_interested' | 'partnered'
--
-- REVERSAL:
--   DROP TABLE IF EXISTS nonprofit_candidates;

CREATE TABLE IF NOT EXISTS nonprofit_candidates (
  id                  TEXT PRIMARY KEY,
  user_email          TEXT NOT NULL,
  opportunity_id      TEXT NOT NULL,
  ein                 TEXT,
  name                TEXT NOT NULL,
  ntee_code           TEXT,
  state               TEXT,
  source              TEXT NOT NULL,
  source_url          TEXT,
  revenue_usd         INTEGER,
  relevance_score     INTEGER NOT NULL DEFAULT 0,
  reasons_json        TEXT NOT NULL DEFAULT '[]',
  themes_json         TEXT NOT NULL DEFAULT '[]',
  disposition         TEXT NOT NULL DEFAULT 'new',
  dedupe_key          TEXT NOT NULL,
  promoted_contact_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (user_email, opportunity_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_npc_owner_opp
  ON nonprofit_candidates(user_email, opportunity_id, relevance_score);
CREATE INDEX IF NOT EXISTS idx_npc_disposition
  ON nonprofit_candidates(user_email, disposition);
