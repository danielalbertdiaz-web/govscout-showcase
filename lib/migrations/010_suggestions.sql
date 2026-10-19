-- Sprint 4: Suggestion Inbox — directive notes per pane
-- Captures "Alfred, do X about this" without leaving the current pane.
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  pane_context_type TEXT,
  pane_context_id TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  triaged_at INTEGER,
  completed_at INTEGER,
  resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggestions_user ON suggestions(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_context ON suggestions(pane_context_type, pane_context_id);
