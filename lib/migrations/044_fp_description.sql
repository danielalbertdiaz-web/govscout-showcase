-- Store the notice/grant description on fp_opportunities (2026-08-25).
--
-- The Riverside grant cron's INGEST payloads carry a `description` per
-- opportunity — the dollar amount and eligibility/fit narrative as free text
-- ("$1.1M CDC supplemental pool for ..."). Until now FpOpportunityInput
-- accepted `description` for scan-gate detection ONLY and then discarded it:
-- every amount and fit note the cron found was silently thrown away at
-- ingest. This column makes it stick.
--
-- Free text on purpose, not a parsed numeric amount column: grant notices
-- mix ranges, ceilings, per-award vs pool totals, and "up to" language —
-- forcing that into a number would launder uncertainty into false precision.
-- The grants pane displays it as text; a structured amount can come later if
-- a real need appears.

ALTER TABLE fp_opportunities ADD COLUMN description TEXT;
