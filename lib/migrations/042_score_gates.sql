-- Scanner scoring gates (2026-08-04, SCANNER_SCORING_DEFECT_PACKET). Three
-- real solicitations were presented as confident AI-deliverability leads
-- (100/100, 80/100, 75/100) scored from the SAM.gov notice text alone —
-- one of them brand-name/sole-source in its own notice text.
--
-- score_basis: what ai_deliverability_score was computed FROM — the
-- machine-readable "this verdict had full information" marker, same pattern
-- as price_basis. Vocabulary in lib/scan-gates.ts ('notice_only' |
-- 'attachment_reviewed'). NULL (all pre-042 rows) reads as 'notice_only'
-- wherever a score exists: unverifiable must never read as verified, so
-- legacy scores need no backfill to be marked unverified.
--
-- scale_signals: JSON array of typed enterprise-scale signals (IL-4/5/6,
-- CSO, staffed labor hours, multi-year T&M, ...) detected in the notice or
-- reported from the attachment. A row carrying signals has its score capped
-- (SCALE_SIGNAL_SCORE_CAP) and routes to a human — the signal DOWNGRADES,
-- it never removes: a wrong auto-kill costs far more than a lead that
-- needed a human glance (the foreign-PoP lesson). Distinct from flagged_at,
-- which is reserved for a human's own priority call.
--
-- Both are written only through upsertFpOpportunity's score gate in
-- lib/federal-pipeline.ts, never directly.

ALTER TABLE fp_opportunities ADD COLUMN score_basis TEXT;
ALTER TABLE fp_opportunities ADD COLUMN scale_signals TEXT;
