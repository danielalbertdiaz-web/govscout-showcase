-- Sprint 5: Boilerplate / Capability Statement Library
-- Canonical reusable blocks; each draft can pin which version it inserted.
CREATE TABLE IF NOT EXISTS boilerplate_blocks (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_bp_key ON boilerplate_blocks(key);

-- Per-draft pin of which version of which block was inserted. Used to warn
-- when a newer version of a block lands upstream.
CREATE TABLE IF NOT EXISTS boilerplate_pins (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL REFERENCES boilerplate_blocks(id) ON DELETE CASCADE,
  block_key TEXT NOT NULL,
  pinned_version INTEGER NOT NULL,
  inserted_at INTEGER NOT NULL,
  position_hint TEXT          -- optional: section/anchor where it landed
);
CREATE INDEX IF NOT EXISTS idx_bp_pins_draft ON boilerplate_pins(draft_id, inserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_bp_pins_block ON boilerplate_pins(block_id);
