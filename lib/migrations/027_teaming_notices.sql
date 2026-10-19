-- Item 5.2 — persisted subaward / teaming notices.
--
-- The teaming scanner discovers SAM.gov "Special Notice" / "Sources Sought"
-- postings filtered to Acme/TechPartners' target NAICS, scores each on teaming-fit
-- (scope, sub-role capacity, relationship-with-prime, prime-quality), and
-- persists them for the standalone /teaming view. A re-scan refreshes the
-- discovery + scoring fields but PRESERVES the operator's disposition and any
-- saved outreach draft.
--
-- Nothing here sends anything. outreach_draft holds a 1.6-sanitized DRAFT that
-- the operator reviews and sends by hand.
--
-- disposition values: 'new' | 'pursuing' | 'outreach_drafted' | 'passed' | 'teamed'
--
-- REVERSAL:
--   DROP TABLE IF EXISTS teaming_notices;

CREATE TABLE IF NOT EXISTS teaming_notices (
  id                TEXT PRIMARY KEY,
  user_email        TEXT NOT NULL,
  notice_id         TEXT NOT NULL,
  title             TEXT NOT NULL,
  agency            TEXT,
  prime             TEXT,
  notice_type       TEXT NOT NULL,
  naics             TEXT,
  description       TEXT,
  posted_date       TEXT,
  response_deadline TEXT,
  set_aside         TEXT,
  url               TEXT,
  source            TEXT NOT NULL,
  fit_score         INTEGER NOT NULL DEFAULT 0,
  reasons_json      TEXT NOT NULL DEFAULT '[]',
  known_prime       INTEGER NOT NULL DEFAULT 0,
  disposition       TEXT NOT NULL DEFAULT 'new',
  outreach_draft    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (user_email, notice_id)
);

CREATE INDEX IF NOT EXISTS idx_teaming_owner_score
  ON teaming_notices(user_email, fit_score);
CREATE INDEX IF NOT EXISTS idx_teaming_disposition
  ON teaming_notices(user_email, disposition);
