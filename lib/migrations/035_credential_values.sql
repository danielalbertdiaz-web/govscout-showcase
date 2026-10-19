-- Audit finding A-1 (2026-08-04): Proposal Memory held Acme Consulting's
-- identifiers as literal "[insert ...]" placeholders in APPROVED blocks
-- reachable by drafting — a capability statement assembled from them would
-- have emitted placeholder text into a funder-facing document.
--
-- Real values supplied by the operator (public business identifiers, not secrets):
--   UEI EXAMPLEUEI00 · CAGE 0ZZZ0 · NJ MBE Confirmation Number 00000000000
--
-- SEED_BLOCKS only applies to a fresh database, so the live rows are updated
-- here, by key, with UPDATE — never delete/reinsert, which would lose
-- approval_status and draft pins. Each UPDATE is guarded on the placeholder
-- text so it is a no-op on a database that never had it (fresh installs get
-- the corrected seeds), and bumps version + updated_at so pinned drafts see
-- that the content changed.
--
-- Deliberately NOT set anywhere: MBE effective/expiration dates and SAM
-- registration expiry — the operator has not supplied them, and a wrong date in a
-- compliance document is worse than a visible placeholder.

-- 1) UEI single-field block: placeholder -> value.
UPDATE boilerplate_blocks
   SET body_markdown = 'EXAMPLEUEI00',
       version = version + 1,
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE key = 'acme-consulting-uei'
   AND body_markdown LIKE '%[insert%';

-- 2) Capability statement: replace the UEI placeholder line and add CAGE
--    beside it.
UPDATE boilerplate_blocks
   SET body_markdown = REPLACE(
         body_markdown,
         '**UEI:** [insert canonical UEI here]',
         '**UEI:** EXAMPLEUEI00' || char(10) || '**CAGE:** 0ZZZ0'
       ),
       version = version + 1,
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE key = 'acme-consulting-capability-statement'
   AND body_markdown LIKE '%[insert canonical UEI here]%';

-- 3) MBE certification: certificate placeholder -> the Confirmation Number
--    the operator supplied (labelled as such — it is not a certificate number).
--    The Effective/Expiration date placeholders are intentionally untouched.
UPDATE boilerplate_blocks
   SET body_markdown = REPLACE(
         body_markdown,
         '- Certificate #: [insert cert number]',
         '- Confirmation Number: 00000000000'
       ),
       version = version + 1,
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE key = 'acme-consulting-mbe-cert'
   AND body_markdown LIKE '%[insert cert number]%';

-- 4) New CAGE block for live databases (fresh installs get it from
--    SEED_BLOCKS; the seeder skips keys that already exist, so this insert
--    does not conflict with it). status/approval mirror the sibling UEI
--    block: seeded 'ready', which migration 033 mapped to 'approved'.
INSERT INTO boilerplate_blocks
  (id, key, title, body_markdown, version, created_at, updated_at, notes,
   category, status, approval_status)
SELECT
  lower(hex(randomblob(16))),
  'acme-consulting-cage',
  'Acme Consulting — CAGE Code',
  '0ZZZ0',
  1,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  'Single-field block. Update if CAGE ever rotates.',
  NULL,
  'ready',
  'approved'
WHERE NOT EXISTS (SELECT 1 FROM boilerplate_blocks WHERE key = 'acme-consulting-cage');
