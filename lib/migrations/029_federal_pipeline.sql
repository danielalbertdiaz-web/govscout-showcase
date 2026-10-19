-- Federal Pipeline Phase 1 (Bid Board) — pipeline state store for the federal
-- micro-to-mid contract operation. Alfred drives state via scripts/fp.mts;
-- the /bid-board pane visualizes. Spec: FEDERAL_PIPELINE_PHASE1_SPEC.md.

CREATE TABLE IF NOT EXISTS fp_opportunities (
  id                       TEXT PRIMARY KEY,
  sol_number               TEXT,
  notice_id                TEXT,
  tracking_number          TEXT,
  title                    TEXT NOT NULL,
  agency                   TEXT,
  office                   TEXT,
  naics                    TEXT,             -- csv
  set_aside                TEXT,
  notice_type              TEXT,
  tier                     TEXT,             -- micro | mid | vehicle
  source                   TEXT NOT NULL DEFAULT 'sam',  -- sam | state | county | subnet | other
  url                      TEXT,
  response_deadline        TEXT,             -- ISO 8601 with offset (tz-aware)
  qa_deadline              TEXT,
  pop_start                TEXT,
  pop_end                  TEXT,
  submission_method        TEXT,             -- email | portal | mail
  submission_target        TEXT,             -- email addr or portal name
  status                   TEXT NOT NULL DEFAULT 'discovered',
  nobid_reason             TEXT,
  ai_deliverability_score  REAL,
  price_quoted             REAL,
  price_basis              TEXT,
  competitors_est          TEXT,
  poc1_name                TEXT,
  poc1_email               TEXT,
  poc1_phone               TEXT,
  poc2_name                TEXT,
  poc2_email               TEXT,
  poc2_phone               TEXT,
  draft_paths              TEXT,             -- json array
  gmail_draft_id           TEXT,
  gmail_sent_ids           TEXT,             -- json array
  result_award_amount      REAL,
  result_awardee           TEXT,
  result_notes             TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_opps_notice
  ON fp_opportunities(notice_id) WHERE notice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fp_opps_sol ON fp_opportunities(sol_number);
CREATE INDEX IF NOT EXISTS idx_fp_opps_status ON fp_opportunities(status);
CREATE INDEX IF NOT EXISTS idx_fp_opps_deadline ON fp_opportunities(response_deadline);

-- Append-only audit trail. Never UPDATE/DELETE rows here.
CREATE TABLE IF NOT EXISTS fp_events (
  id      TEXT PRIMARY KEY,
  opp_id  TEXT NOT NULL REFERENCES fp_opportunities(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  detail  TEXT              -- json
);

CREATE INDEX IF NOT EXISTS idx_fp_events_opp ON fp_events(opp_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_fp_events_kind ON fp_events(kind, ts DESC);
