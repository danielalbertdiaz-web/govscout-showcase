-- Sprint AI enhancements — strategic scoring, compliance flags, pipeline stages,
-- and contact intelligence.

-- Strategic multi-criteria scoring on saved_opportunities.
-- strategic_score: 0–100 weighted composite (6-criteria matrix).
-- strategic_score_detail: JSON breakdown per criterion.
-- scored_at: epoch ms.
ALTER TABLE saved_opportunities ADD COLUMN strategic_score REAL;
ALTER TABLE saved_opportunities ADD COLUMN strategic_score_detail TEXT;
ALTER TABLE saved_opportunities ADD COLUMN strategic_scored_at INTEGER;

-- Compliance flags on saved_opportunities.
-- compliance_status: 'pending' | 'pass' | 'fail' | 'warn'
-- compliance_detail: JSON array of check results.
-- compliance_checked_at: epoch ms.
ALTER TABLE saved_opportunities ADD COLUMN compliance_status TEXT;
ALTER TABLE saved_opportunities ADD COLUMN compliance_detail TEXT;
ALTER TABLE saved_opportunities ADD COLUMN compliance_checked_at INTEGER;

-- Proposal pipeline stage on saved_opportunities.
-- pipeline_stage: NULL = not in pipeline; otherwise one of the lifecycle keys.
-- pipeline_updated_at: epoch ms of last stage change.
-- pipeline_meta: JSON for automation level, checkpoints, notes.
ALTER TABLE saved_opportunities ADD COLUMN pipeline_stage TEXT;
ALTER TABLE saved_opportunities ADD COLUMN pipeline_updated_at INTEGER;
ALTER TABLE saved_opportunities ADD COLUMN pipeline_meta TEXT;

CREATE INDEX IF NOT EXISTS idx_saved_opp_strategic_score ON saved_opportunities(strategic_score DESC);
CREATE INDEX IF NOT EXISTS idx_saved_opp_compliance ON saved_opportunities(compliance_status);
CREATE INDEX IF NOT EXISTS idx_saved_opp_pipeline ON saved_opportunities(pipeline_stage);

-- Contact intelligence table.
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  agency TEXT,
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  -- relationship tracking
  relationship_quality TEXT NOT NULL DEFAULT 'unknown',
  last_contact_at INTEGER,
  contact_count INTEGER NOT NULL DEFAULT 0,
  response_rate REAL,
  -- outreach optimization
  preferred_method TEXT,
  best_time TEXT,
  success_notes TEXT,
  -- compliance flags
  compliance_flag TEXT,
  compliance_note TEXT,
  -- flexible tags + notes
  tags_json TEXT,
  notes TEXT,
  raw_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_email, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_agency ON contacts(user_email, agency);
CREATE INDEX IF NOT EXISTS idx_contacts_flag ON contacts(compliance_flag);

-- Contact-opportunity join: which contacts are relevant to which saved opportunity.
CREATE TABLE IF NOT EXISTS contact_opportunities (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES saved_opportunities(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (contact_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_copp_opp ON contact_opportunities(opportunity_id);
