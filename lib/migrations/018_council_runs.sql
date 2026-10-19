-- Sprint 10: 4-Agent Contextual Council Pane
-- Council runs store the output of the AI deliberation engine that scores
-- and revises grant drafts. Each council run is linked to a specific draft
-- and includes all 4 agent outputs (Domain Expert, Contrarian, Budget Reviewer, Synthesizer).

CREATE TABLE council_runs (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  triggered_at INTEGER NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('auto', 'manual')),
  agent_outputs TEXT NOT NULL, -- JSON: full output per agent
  revision_plan TEXT, -- JSON: structured revision plan from Synthesizer
  pre_score REAL, -- pre-revision score
  post_score REAL, -- post-revision score
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
  human_decision TEXT CHECK (human_decision IN ('submit', 'needs_more_review', 'reject')),
  human_decision_at INTEGER,
  cost_usd REAL, -- actual cost in USD for this council run
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_council_runs_draft ON council_runs(draft_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_council_runs_status ON council_runs(status);
CREATE INDEX IF NOT EXISTS idx_council_runs_cost ON council_runs(cost_usd);