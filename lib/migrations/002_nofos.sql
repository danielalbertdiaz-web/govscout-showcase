-- Stage 3a — NOFO library.
-- Persist every successfully-extracted NOFO so the user can browse, search,
-- and reload past solicitations into the workbench.

CREATE TABLE IF NOT EXISTS nofos (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  agency TEXT,
  program TEXT,
  funding_floor TEXT,
  funding_ceiling TEXT,
  period_of_performance TEXT,
  key_dates_json TEXT,
  eligibility TEXT,
  evaluation_criteria_json TEXT,
  required_sections_json TEXT,
  summary TEXT,
  raw_text TEXT,
  original_filename TEXT,
  extracted_at INTEGER NOT NULL,
  tags_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_nofos_user ON nofos(user_email);
CREATE INDEX IF NOT EXISTS idx_nofos_extracted ON nofos(extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_nofos_agency ON nofos(agency);
CREATE INDEX IF NOT EXISTS idx_nofos_program ON nofos(program);

-- Link drafts to the NOFO they were generated from. Nullable so legacy drafts
-- (and pasted-text drafts that never went through upload) keep working.
ALTER TABLE drafts ADD COLUMN nofo_id TEXT REFERENCES nofos(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_drafts_nofo ON drafts(nofo_id);
