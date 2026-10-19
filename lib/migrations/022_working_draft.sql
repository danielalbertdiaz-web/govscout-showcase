-- Item 2.2: Working Draft side pane.
-- Holds completed draft blocks promoted out of the section editor, in an
-- explicit order, so they can be assembled into one combined document.
-- working_draft_assemblies stores each assembled output against the draft
-- (= the opportunity), keeping a history rather than overwriting.
--
-- REVERSIBLE: rollback drops both tables —
--   DROP TABLE IF EXISTS working_draft_assemblies;
--   DROP TABLE IF EXISTS working_draft_items;

CREATE TABLE IF NOT EXISTS working_draft_items (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'section',  -- 'section' | 'boilerplate' | 'manual'
  source_ref TEXT,                              -- section key / block key, if any
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wd_items_draft ON working_draft_items(draft_id, position ASC);

CREATE TABLE IF NOT EXISTS working_draft_assemblies (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  content_markdown TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wd_asm_draft ON working_draft_assemblies(draft_id, created_at DESC);
