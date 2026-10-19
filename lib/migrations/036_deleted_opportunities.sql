-- Permanent delete with tombstones (2026-08-04, the operator's decision — replaces
-- the 034 archive model).
--
-- A plain DELETE is not permanent here: both importers dedupe on natural keys
-- (micro: user_email+notice_id; federal: notice_id then sol_number), so a
-- hard-deleted row is re-INSERTed by the next sweep — "gone until the next
-- scan", typically four hours. The tombstone is what makes delete permanent:
-- importers skip any record whose natural key matches one.
--
-- title/agency are kept deliberately: a tombstone with only an opaque id
-- cannot answer "why is this not on my board" six weeks later.
--
-- archived_at on fp_opportunities stays (dropping a column is not worth the
-- risk); nothing writes it any more and the list no longer filters on it.

CREATE TABLE IF NOT EXISTS deleted_opportunities (
  id          TEXT PRIMARY KEY,     -- id of the deleted row (provenance)
  source      TEXT NOT NULL,        -- 'federal' | 'micro'
  notice_id   TEXT,
  sol_number  TEXT,
  title       TEXT NOT NULL,
  agency      TEXT,
  reason      TEXT,
  deleted_at  INTEGER NOT NULL,
  deleted_by  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deleted_opps_notice ON deleted_opportunities(notice_id);
CREATE INDEX IF NOT EXISTS idx_deleted_opps_sol ON deleted_opportunities(sol_number);
