-- Sprint 3 (pivot v2) — A1 Scout fit-scoring.
-- Adds fit-score columns to scout_items so the /scouts pane can rank items
-- against Acme Consulting's BUSINESS_PROFILE (see lib/profile.ts).
--
-- score: 0–100 nullable (NULL = unscored). score_rationale: model rationale.
-- scored_at: epoch ms when the score was written. C6 — scoring is on-demand
-- only (POST /api/scouts/score-batch), no new crons.

ALTER TABLE scout_items ADD COLUMN score REAL;
ALTER TABLE scout_items ADD COLUMN score_rationale TEXT;
ALTER TABLE scout_items ADD COLUMN scored_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_scout_items_score ON scout_items(score DESC);
