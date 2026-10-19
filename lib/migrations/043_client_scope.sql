-- Client-panel corpus isolation, tracking layer (PANEL_ISOLATION_SPEC.md §2).
-- the operator now consults for Riverside (and soon Northstar Training Institute); one blended GovScout
-- corpus is a conflict-of-interest problem, not a UX bug. client_id is the
-- second scoping dimension alongside user_email (which stays — identity, not
-- tenant). Canonical values live in ONE place: CLIENT_IDS in
-- lib/federal-pipeline-types.ts ('el' | 'riverside' | 'northstar' — northstar reserved now
-- per spec §6.1 so this migration runs once). Writes are validated through
-- requireClientId in lib/client-scope.ts; deliberately no CHECK constraint,
-- because adding a client later must not force a six-table rebuild.
--
-- DEFAULT 'el' is doing two jobs: (1) SQLite requires a default to ADD a NOT
-- NULL column, and it backfills every existing row — GovScout's entire
-- operating history to date is Acme's own pipeline, so 'el' is the true value,
-- not a guess. (2) The drafting-side tables (nofos, drafts, decision_queue,
-- auto_draft_*) keep relying on this default at write time until the
-- drafting-side chokepoint lands (spec §3, deferred — only Acme drafts today).
-- fp_opportunities writes never rely on it: upsertFpOpportunity requires an
-- explicit, validated clientId.
--
-- fp_events needs no column (scope inherited via opp_id). boilerplate_blocks
-- is deliberately NOT here: its rows need a per-block human classification
-- (Acme-specific vs shared), not a blanket 'el' backfill — spec §6.2, deferred.
-- deleted_opportunities (tombstones) also stays global for now: every
-- existing tombstone is an Acme-era judgement; consequence, a notice Acme deleted
-- cannot be re-ingested for another client until tombstones are scoped.

ALTER TABLE fp_opportunities ADD COLUMN client_id TEXT NOT NULL DEFAULT 'el';
ALTER TABLE nofos ADD COLUMN client_id TEXT NOT NULL DEFAULT 'el';
ALTER TABLE drafts ADD COLUMN client_id TEXT NOT NULL DEFAULT 'el';
ALTER TABLE decision_queue ADD COLUMN client_id TEXT NOT NULL DEFAULT 'el';
ALTER TABLE auto_draft_log ADD COLUMN client_id TEXT NOT NULL DEFAULT 'el';
ALTER TABLE auto_draft_queue ADD COLUMN client_id TEXT NOT NULL DEFAULT 'el';

-- The board panels and the CLI filter fp_opportunities by client on every
-- read; the other tables are low-row-count and read through drafting paths.
CREATE INDEX IF NOT EXISTS idx_fp_opportunities_client_id
  ON fp_opportunities (client_id);

-- Notice identity is per-client now: two clients tracking the same federal
-- notice are two independent rows (upsert dedupe is scoped to match). The
-- 029-era global unique index would make the second client's ingest a
-- constraint error, so it is rebuilt composite.
DROP INDEX IF EXISTS idx_fp_opps_notice;
CREATE UNIQUE INDEX idx_fp_opps_notice
  ON fp_opportunities (client_id, notice_id) WHERE notice_id IS NOT NULL;
