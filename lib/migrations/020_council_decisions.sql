-- Sprint 11 (P1-4): append-only audit trail for human submit-gate decisions.
-- council_runs.human_decision is a single mutable column; this table records an
-- immutable history row for every recorded decision (who, what, the score and
-- recommendation snapshotted at decision time, and when). Rows are only ever
-- INSERTed — never updated or deleted by application code.
CREATE TABLE council_decisions (
  id TEXT PRIMARY KEY,
  council_run_id TEXT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
  draft_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('submit', 'needs_more_review', 'reject')),
  post_score REAL,            -- post-revision score at the moment of decision
  recommendation TEXT,        -- synthesizer recommendation at the moment of decision
  decided_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_council_decisions_run ON council_decisions(council_run_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_council_decisions_user ON council_decisions(user_email, decided_at DESC);
