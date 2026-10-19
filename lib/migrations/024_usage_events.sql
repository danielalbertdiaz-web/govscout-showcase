-- Migration 024: usage attribution (Item 3.2). Visibility only — no caps, no
-- gating, no EV math. Every Claude invocation appends one immutable row here so
-- token/cost spend can be attributed to an opportunity + pipeline stage + model.
--
-- Aggregations are VIEWS, never stored totals: the truth is always the sum of
-- the event log, so there is nothing to drift or reconcile. To roll back, drop
-- the three views then the table; no other table is touched.
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  user_email TEXT,              -- nullable: low-level calls may lack a session
  opportunity_id TEXT,          -- nullable: not every call maps to an opportunity
  draft_id TEXT,                -- nullable: council/synth attribute by draft
  stage TEXT NOT NULL DEFAULT 'uncategorized',
  source TEXT,                  -- subsystem that issued the call (council, synthesize, ...)
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usage_events_opportunity ON usage_events (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_draft ON usage_events (draft_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events (created_at);

-- Live aggregation views. Querying these is always consistent with the log.
CREATE VIEW IF NOT EXISTS usage_by_opportunity AS
  SELECT
    opportunity_id,
    COUNT(*)               AS events,
    SUM(input_tokens)      AS input_tokens,
    SUM(output_tokens)     AS output_tokens,
    SUM(cost_usd)          AS cost_usd,
    MAX(created_at)        AS last_at
  FROM usage_events
  GROUP BY opportunity_id;

CREATE VIEW IF NOT EXISTS usage_by_stage AS
  SELECT
    stage,
    COUNT(*)               AS events,
    SUM(input_tokens)      AS input_tokens,
    SUM(output_tokens)     AS output_tokens,
    SUM(cost_usd)          AS cost_usd
  FROM usage_events
  GROUP BY stage;

CREATE VIEW IF NOT EXISTS usage_by_model AS
  SELECT
    model,
    COUNT(*)               AS events,
    SUM(input_tokens)      AS input_tokens,
    SUM(output_tokens)     AS output_tokens,
    SUM(cost_usd)          AS cost_usd
  FROM usage_events
  GROUP BY model;
