-- Sprint 7: Auto-draft trigger.
--
-- drafts.status now accepts an additional 'auto_drafted' value alongside
-- the existing drafting|submitted|won|lost. There is no CHECK constraint
-- on the column today, so no ALTER required for the enum itself; the
-- DRAFT_STATUSES array in lib/db.ts is the canonical list.
--
-- auto_draft_log records every trigger attempt (one row per attempt,
-- whatever the outcome). Used for both idempotency (`opportunity_key`)
-- and the 3-per-24h rate-limit window (count of outcome='created' in
-- the trailing 86_400_000 ms for a user).
--
-- auto_draft_queue holds attempts deferred by the rate limit. The 4th
-- hit in a 24h window writes a `queued` log row AND a queue row; the
-- Suggestion Inbox surfaces the queue and the operator releases manually.

CREATE TABLE IF NOT EXISTS auto_draft_log (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,         -- "opp:<id>" or "nofo:<id>" — idempotency key
  source_kind TEXT NOT NULL,             -- "saved_opportunity" | "nofo"
  source_id TEXT NOT NULL,
  score REAL NOT NULL,                   -- the score that triggered the attempt
  threshold REAL NOT NULL,               -- threshold at the time of attempt
  outcome TEXT NOT NULL,                 -- "created" | "skipped" | "blocked_memory_guard" | "queued"
  reason TEXT,                           -- short machine-friendly tag, e.g. "deadline_passed"
  draft_id TEXT,                         -- populated when outcome='created'
  detail_json TEXT                       -- e.g. memory-guard flag list, partner-match results
);

CREATE INDEX IF NOT EXISTS idx_adl_user_created ON auto_draft_log(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adl_opportunity ON auto_draft_log(opportunity_key);
CREATE INDEX IF NOT EXISTS idx_adl_outcome ON auto_draft_log(outcome);

CREATE TABLE IF NOT EXISTS auto_draft_queue (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  opportunity_key TEXT NOT NULL UNIQUE,  -- one queue row per opportunity until released
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  score REAL NOT NULL,
  threshold REAL NOT NULL,
  released_at INTEGER,
  released_draft_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_adq_user_open ON auto_draft_queue(user_email, released_at);
