-- V4.1 §14.9 — Proposal Memory controls.
--
-- boilerplate_blocks carried body text, a version integer, free-text notes and
-- a 'ready'/'needs_review' status. Nothing recorded where a claim came from,
-- whether it was approved, when it stops being true, who may see it, which
-- funder it must not be reused for, or that it must not be reused at all.
--
-- The risk this closes: an indirect-rate paragraph or a past-performance claim
-- stays in the library after the underlying agreement expires, and a later
-- draft cites it as current. Expiry has to be a property of the record, not
-- something a human is expected to remember.
--
-- Additive only. Existing rows keep working: approval_status defaults to the
-- pre-existing meaning of status, and NULL dates mean "no constraint".

ALTER TABLE boilerplate_blocks ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'unreviewed';
ALTER TABLE boilerplate_blocks ADD COLUMN approved_by TEXT;
ALTER TABLE boilerplate_blocks ADD COLUMN approved_at INTEGER;
ALTER TABLE boilerplate_blocks ADD COLUMN source TEXT;
ALTER TABLE boilerplate_blocks ADD COLUMN content_hash TEXT;
ALTER TABLE boilerplate_blocks ADD COLUMN effective_from INTEGER;
ALTER TABLE boilerplate_blocks ADD COLUMN expires_at INTEGER;
ALTER TABLE boilerplate_blocks ADD COLUMN confidentiality TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE boilerplate_blocks ADD COLUMN permitted_use TEXT;
-- JSON array of funder/customer identifiers this block must NOT be used for.
ALTER TABLE boilerplate_blocks ADD COLUMN restricted_funders_json TEXT;
ALTER TABLE boilerplate_blocks ADD COLUMN do_not_reuse INTEGER NOT NULL DEFAULT 0;
ALTER TABLE boilerplate_blocks ADD COLUMN do_not_reuse_reason TEXT;
-- Points at the block that replaced this one, so a superseded claim can be
-- traced forward rather than silently disappearing.
ALTER TABLE boilerplate_blocks ADD COLUMN superseded_by TEXT;

CREATE INDEX IF NOT EXISTS idx_boilerplate_approval ON boilerplate_blocks(approval_status);
CREATE INDEX IF NOT EXISTS idx_boilerplate_expiry ON boilerplate_blocks(expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_boilerplate_dnr ON boilerplate_blocks(do_not_reuse)
  WHERE do_not_reuse = 1;

-- Carry the existing status forward so nothing regresses: blocks already
-- marked 'ready' are treated as approved, the rest need review.
UPDATE boilerplate_blocks SET approval_status = 'approved' WHERE status = 'ready';
UPDATE boilerplate_blocks SET approval_status = 'needs_review' WHERE status = 'needs_review';
