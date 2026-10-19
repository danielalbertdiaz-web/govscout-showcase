-- Sprint 3 (pivot v2) — A2 NOFO fit-scoring.
-- Mirrors 005_scout_scores.sql for the nofos table.

ALTER TABLE nofos ADD COLUMN score REAL;
ALTER TABLE nofos ADD COLUMN score_rationale TEXT;
ALTER TABLE nofos ADD COLUMN scored_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_nofos_score ON nofos(score DESC);
