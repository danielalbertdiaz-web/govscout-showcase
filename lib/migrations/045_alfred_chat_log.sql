-- GovScout-side display/audit log for the Alfred chat bridge (2026-08-25
-- build spec). NOT the authoritative transcript — that lives in the OpenClaw
-- session store for agent:main:main, same as the Telegram conversation this
-- bridge joins. This table exists so the GovScout panel can render history
-- and poll for long-running replies (turns regularly run 30-240s) without
-- holding an HTTP request open.
--
-- Deliberately NOT copilot_chats: that table is GovScout's own assistant's
-- history; mixing the two would make it unclear which "chat" a transcript
-- belongs to.

CREATE TABLE IF NOT EXISTS alfred_chat_log (
  -- Also used as the chat.send idempotencyKey, which the Gateway adopts as
  -- the runId — one id ties the row, the RPC, and the event stream together,
  -- and a retried/duplicate POST cannot create a second turn.
  id TEXT PRIMARY KEY,
  -- Optional cron job context ("Chat about this job" prefill provenance).
  job_id TEXT,
  user_email TEXT NOT NULL,
  message TEXT NOT NULL,
  reply TEXT,
  -- pending | done | error | aborted
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_alfred_chat_log_created
  ON alfred_chat_log(created_at DESC);
