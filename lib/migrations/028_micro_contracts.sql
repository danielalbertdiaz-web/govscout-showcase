-- Micro Contracts — direct-bid federal contract opportunities from SAM.gov.
-- Parallel to teaming_notices (027) but for prime contracting, not subbing.

CREATE TABLE IF NOT EXISTS micro_contracts (
  id                TEXT PRIMARY KEY,
  user_email        TEXT NOT NULL,
  notice_id         TEXT NOT NULL,
  sol_number        TEXT,
  title             TEXT NOT NULL,
  agency            TEXT,
  notice_type       TEXT NOT NULL,
  naics             TEXT,
  description       TEXT,
  posted_date       TEXT,
  response_deadline TEXT,
  set_aside         TEXT,
  url               TEXT,
  source            TEXT NOT NULL DEFAULT 'sam_gov',
  disposition       TEXT NOT NULL DEFAULT 'new',
  response_draft    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(user_email, notice_id)
);

CREATE INDEX IF NOT EXISTS idx_micro_contracts_user
  ON micro_contracts(user_email, response_deadline ASC);
CREATE INDEX IF NOT EXISTS idx_micro_contracts_deadline
  ON micro_contracts(response_deadline ASC)
  WHERE disposition != 'passed';
