-- V4.1 §14.5 — durable, idempotent NOFO extraction records.
--
-- The nofos table stored the extracted fields but nothing about the extraction
-- itself: no hash of the source document, no extractor version, no confidence,
-- no link to an opportunity, no record of human corrections. Two consequences:
--
--   1. Re-uploading the same PDF produced a second row. There was no way to
--      recognise an unchanged document, so re-extraction was never idempotent.
--   2. When a later model version extracted a field differently, there was no
--      way to tell which rows came from which extractor, or which fields a
--      human had already corrected and must not be overwritten.
--
-- source_hash is SHA-256 over the extracted raw text, not the file bytes: the
-- same NOFO fetched as a PDF and pasted as text should resolve to one record.

ALTER TABLE nofos ADD COLUMN source_hash TEXT;
ALTER TABLE nofos ADD COLUMN extraction_version TEXT;
ALTER TABLE nofos ADD COLUMN extraction_model TEXT;
ALTER TABLE nofos ADD COLUMN extraction_confidence REAL;
ALTER TABLE nofos ADD COLUMN opportunity_id TEXT;
ALTER TABLE nofos ADD COLUMN solicitation_number TEXT;
ALTER TABLE nofos ADD COLUMN attachments_json TEXT;
-- Field-level human overrides: {"agency": {"value": "...", "at": 1234, "by": "..."}}
ALTER TABLE nofos ADD COLUMN human_corrections_json TEXT;
ALTER TABLE nofos ADD COLUMN updated_at INTEGER;

-- One record per (owner, source document). Partial so the existing rows with a
-- NULL hash — and any future row whose text could not be hashed — do not
-- collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nofos_owner_source
  ON nofos(user_email, source_hash)
  WHERE source_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nofos_opportunity ON nofos(opportunity_id)
  WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nofos_solicitation ON nofos(solicitation_number)
  WHERE solicitation_number IS NOT NULL;
