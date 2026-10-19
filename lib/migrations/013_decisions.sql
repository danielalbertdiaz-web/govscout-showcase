-- Sprint 5: Decision Queue — batched "Alfred needs the operator to decide X" list.
-- Foundational for Sprint 6 Alfred Console which will write to this heavily.
CREATE TABLE IF NOT EXISTS decision_queue (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  question TEXT NOT NULL,
  context_type TEXT,
  context_id TEXT,
  options_json TEXT NOT NULL,        -- ["option a", "option b", ...]
  recommended_option TEXT,
  recommended_reason TEXT,
  deadline_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'open',  -- open | decided | deferred | dismissed
  decided_at INTEGER,
  decision TEXT,
  decision_note TEXT,
  action_kind TEXT,                  -- optional follow-up: e.g. "set_partner_pairing"
  action_payload TEXT,               -- JSON-encoded action params
  action_status TEXT                 -- pending | fired | failed | skipped | null
);
CREATE INDEX IF NOT EXISTS idx_decisions_user_status ON decision_queue(user_email, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_context ON decision_queue(context_type, context_id);
CREATE INDEX IF NOT EXISTS idx_decisions_deadline ON decision_queue(deadline_ms);
