-- Sprint 11 (P0-3): durable backstop for the per-draft single-run lock.
-- A draft may have at most one council run in the 'running' state at a time.
-- This partial unique index enforces that at the database level, closing the
-- check-then-insert race even across multiple processes / serverless instances
-- where the application-level BEGIN IMMEDIATE guard in createCouncilRun() is
-- not sufficient on its own.
CREATE UNIQUE INDEX IF NOT EXISTS idx_council_runs_one_running_per_draft
  ON council_runs(draft_id) WHERE status = 'running';
