-- Sprint 3 (pivot v2) — B1 Copilot pane (optional persistence).
-- Trivial chat history per user; ephemeral sessions are fine but persisting
-- means refresh doesn't lose context. C4 single-user — user_email is a tag,
-- not auth.

CREATE TABLE IF NOT EXISTS copilot_chats (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  context_kind TEXT,         -- scout | pool | nofo | draft | null
  context_id TEXT,           -- referenced record id
  title TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_chats_user ON copilot_chats(user_email, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS copilot_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES copilot_chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,        -- user | assistant | system
  content TEXT NOT NULL,
  model TEXT,                -- model used for assistant turns
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_messages_chat ON copilot_messages(chat_id, created_at_ms ASC);
