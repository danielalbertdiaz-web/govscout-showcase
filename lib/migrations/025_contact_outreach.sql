-- Item 4.3 — cold-outreach pipeline state on contacts.
--
-- Adds an outreach pipeline status (orthogonal to relationship_quality), a
-- stored per-contact intro DRAFT (nothing auto-sends), and an import-source tag
-- so LinkedIn-imported leads can be filtered/de-duped. All columns are additive,
-- nullable or defaulted — existing rows are untouched.
--
-- SQLite allows one ADD COLUMN per ALTER statement.
--
-- REVERSAL (SQLite >= 3.35, which better-sqlite3 bundles):
--   ALTER TABLE contacts DROP COLUMN outreach_status;
--   ALTER TABLE contacts DROP COLUMN intro_draft;
--   ALTER TABLE contacts DROP COLUMN intro_draft_at;
--   ALTER TABLE contacts DROP COLUMN source;
--   DROP INDEX IF EXISTS idx_contacts_outreach;
--   DROP INDEX IF EXISTS idx_contacts_source;

ALTER TABLE contacts ADD COLUMN outreach_status TEXT NOT NULL DEFAULT 'not_contacted';
ALTER TABLE contacts ADD COLUMN intro_draft TEXT;
ALTER TABLE contacts ADD COLUMN intro_draft_at INTEGER;
ALTER TABLE contacts ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_outreach ON contacts(user_email, outreach_status);
CREATE INDEX IF NOT EXISTS idx_contacts_source ON contacts(user_email, source);
