-- set_aside_canonical (improvement #2, 2026-08-04): the controlled vocabulary
-- from lib/set-aside.ts, materialised on fp_opportunities and micro_contracts.
--
-- The raw set_aside column is DELIBERATELY untouched — provenance is never
-- discarded; this migration only ADDs the canonical column and backfills it.
--
-- The backfill mirrors lib/set-aside.ts normaliseSetAside over the exact
-- value set present in the live database at migration time (verified by
-- enumeration; the fallback is 'unknown'). Going forward the TS normaliser is
-- authoritative — both upserts stamp the column at ingest — so any future
-- drift self-heals as rows are re-ingested.
--
-- CARDINAL RULE (same as the module): absent or unrecognised maps to
-- 'unknown', NEVER to 'none'. "Not classified" and "open to everyone" are
-- opposite claims. NULL raw values (all 295 micro rows — the sweep importer
-- does not capture the field) are uncaptured data, not declarations, so they
-- backfill as 'unknown'.

ALTER TABLE fp_opportunities ADD COLUMN set_aside_canonical TEXT;
ALTER TABLE micro_contracts ADD COLUMN set_aside_canonical TEXT;

UPDATE fp_opportunities SET set_aside_canonical = CASE
  WHEN set_aside IS NULL OR trim(set_aside) = '' THEN 'unknown'
  WHEN lower(trim(set_aside)) IN ('none', 'none (full & open)', 'full and open', 'full & open', 'unrestricted', 'n/a', 'no set-aside', 'no set aside') THEN 'none'
  WHEN lower(trim(set_aside)) IN ('sba', 'total small business', 'total small business set-aside', 'sba total small business') THEN 'small_business'
  WHEN lower(trim(set_aside)) = '8(a) competitive' OR lower(trim(set_aside)) LIKE '%8(a)%' THEN '8a'
  -- Speculative phrasings ("TBD — RFI states may be small-business set-aside
  -- or full & open", "Sources Sought (may set aside SB or full/open)",
  -- "RFI/Sources Sought...") say the set-aside is UNDECIDED: unknown, not
  -- either specific reading.
  ELSE 'unknown'
END;

UPDATE micro_contracts SET set_aside_canonical = CASE
  WHEN set_aside IS NULL OR trim(set_aside) = '' THEN 'unknown'
  WHEN lower(trim(set_aside)) IN ('none', 'none (full & open)', 'full and open', 'full & open', 'unrestricted', 'n/a', 'no set-aside', 'no set aside') THEN 'none'
  WHEN lower(trim(set_aside)) IN ('sba', 'total small business', 'total small business set-aside', 'sba total small business') THEN 'small_business'
  WHEN lower(trim(set_aside)) LIKE '%8(a)%' THEN '8a'
  ELSE 'unknown'
END;

CREATE INDEX IF NOT EXISTS idx_fp_opps_set_aside_canonical ON fp_opportunities(set_aside_canonical);
CREATE INDEX IF NOT EXISTS idx_micro_set_aside_canonical ON micro_contracts(set_aside_canonical);
