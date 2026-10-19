-- R-1 phase 1 (2026-08-04): link Layer-1 staging rows to their Layer-2
-- canonical counterpart.
--
-- Per PIPELINE_SCHEMA_DECISION.md, micro_contracts is staging (everything the
-- sweep saw, including kills) and fp_opportunities is canonical. 10 pairs
-- share a notice_id and 21 a sol_number with NO link between them, so the
-- same solicitation could carry opposite states on adjacent screens
-- (fp:triaged_bid vs micro:passed, live).
--
-- NULL means "not linked", which is the NORMAL state — most staging rows
-- (roughly 285 of 295) never become canonical, and that is correct, not a
-- gap. The column is backfilled by scripts/link-opportunities.mts (dry-run
-- first, --apply only after human review of the conflict report) and
-- maintained at ingest by upsertMicroContract. No state is ever copied
-- between the tables; conflicts are surfaced, never auto-resolved.

ALTER TABLE micro_contracts ADD COLUMN fp_opportunity_id TEXT;

CREATE INDEX IF NOT EXISTS idx_micro_fp_link ON micro_contracts(fp_opportunity_id);
