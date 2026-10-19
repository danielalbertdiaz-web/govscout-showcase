-- Track L Phase 1 (Earmarked Awareness Radar) — health agencies holding
-- earmarked lead-hazard/awareness funds, scored + tiered for Acme outreach.
-- Spec: GOVSCOUT-TRACK-L.md §1. Strictly additive: pure CREATEs, no touches
-- to existing tables. Adapted from the spec's Prisma-style model to this
-- repo's SQLite conventions: snake_case, INTEGER ms timestamps, JSON-in-TEXT
-- (reason_codes String[] → reason_codes TEXT holding a JSON array — noted
-- for the future Postgres/Prisma migration). tenant_id is kept on every
-- table with a single hardcoded tenant constant (lib/track-l-types.ts).

CREATE TABLE IF NOT EXISTS trackl_agencies (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  name                   TEXT NOT NULL,
  type                   TEXT NOT NULL DEFAULT 'OTHER',  -- STATE_HEALTH | LOCAL_HEALTH | WATER_SYSTEM | HOUSING | OTHER
  state                  TEXT NOT NULL,                  -- 2-letter
  county                 TEXT,
  fips_code              TEXT,
  website                TEXT,
  procurement_threshold  INTEGER,          -- dollars; null = unverified
  quote_requirement      TEXT,             -- free text, e.g. "3 informal quotes"
  fiscal_year_end        TEXT,             -- "MM-DD"
  housing_pre1978_pct    REAL,             -- §4 quirk: proxied from ACS B25034 pre-1980 buckets
  blood_lead_elevated    INTEGER,          -- boolean 0/1; null = unknown
  score                  INTEGER NOT NULL DEFAULT 0,
  reason_codes           TEXT NOT NULL DEFAULT '[]',     -- json array of human-readable strings
  tier                   TEXT NOT NULL DEFAULT 'STANDARD', -- DREAM | STANDARD | LOW
  snapshot_url           TEXT,             -- P2
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- idempotency anchor (§1 @@unique([tenantId, name, state]))
CREATE UNIQUE INDEX IF NOT EXISTS idx_trackl_agencies_natural
  ON trackl_agencies(tenant_id, name, state);
CREATE INDEX IF NOT EXISTS idx_trackl_agencies_tenant ON trackl_agencies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trackl_agencies_fips ON trackl_agencies(fips_code);
CREATE INDEX IF NOT EXISTS idx_trackl_agencies_state ON trackl_agencies(state);
CREATE INDEX IF NOT EXISTS idx_trackl_agencies_tier ON trackl_agencies(tier, score DESC);

CREATE TABLE IF NOT EXISTS trackl_contacts (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  agency_id       TEXT NOT NULL REFERENCES trackl_agencies(id) ON DELETE CASCADE,
  name            TEXT,             -- null allowed for generic inboxes
  title           TEXT,
  email           TEXT NOT NULL,
  email_verified  INTEGER NOT NULL DEFAULT 0,  -- P2
  is_generic      INTEGER NOT NULL DEFAULT 0,  -- info@ / health@ class
  priority        TEXT NOT NULL,    -- P1_CLPPP | P2_HEALTH_OFFICER | P3_PIO | P4_GENERIC
  source          TEXT NOT NULL,    -- NACCHO | ASTHO | CLPPP | HUD_AWARD | DEPT_SITE | CENSUS_XREF
  source_url      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trackl_contacts_natural
  ON trackl_contacts(tenant_id, agency_id, email);
CREATE INDEX IF NOT EXISTS idx_trackl_contacts_tenant ON trackl_contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trackl_contacts_agency ON trackl_contacts(agency_id);

CREATE TABLE IF NOT EXISTS trackl_funding_events (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  agency_id        TEXT NOT NULL REFERENCES trackl_agencies(id) ON DELETE CASCADE,
  program          TEXT NOT NULL,   -- HUD_LHC | HUD_HH | EPA_WIIN | LSLR_STATE | OPIOID | OTHER
  amount           INTEGER,
  award_date       TEXT,            -- ISO date
  spend_deadline   TEXT,            -- ISO date
  source_url       TEXT NOT NULL,
  raw_archive_key  TEXT,            -- storage key of archived source page/JSON
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- §1 @@unique([tenantId, agencyId, program, awardDate]) — COALESCE keeps the
-- key idempotent when award_date is null (SQLite treats NULLs as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_trackl_funding_natural
  ON trackl_funding_events(tenant_id, agency_id, program, COALESCE(award_date, ''));
CREATE INDEX IF NOT EXISTS idx_trackl_funding_tenant ON trackl_funding_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trackl_funding_agency ON trackl_funding_events(agency_id);

CREATE TABLE IF NOT EXISTS trackl_signals (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  agency_id    TEXT NOT NULL REFERENCES trackl_agencies(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,  -- AWARD_RECENT | SPEND_DEADLINE | BLOOD_LEAD_ELEVATED | HOUSING_PRE1978 | LSLR_MANDATE | NEWS_EVENT
  weight       INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL,
  source_url   TEXT,
  note         TEXT
);

-- Not in the spec (Signal has no @@unique) but required by acceptance §8
-- "all jobs re-run with zero duplicates": one signal per agency/type/source.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trackl_signals_dedupe
  ON trackl_signals(tenant_id, agency_id, type, COALESCE(source_url, ''));
CREATE INDEX IF NOT EXISTS idx_trackl_signals_tenant ON trackl_signals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trackl_signals_agency ON trackl_signals(agency_id);

CREATE TABLE IF NOT EXISTS trackl_outreach_status (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  agency_id        TEXT NOT NULL UNIQUE REFERENCES trackl_agencies(id) ON DELETE CASCADE,
  stage            TEXT NOT NULL DEFAULT 'COLD',  -- COLD | SEQUENCED | REPLIED | BRIEFING_SET | BRIEFING_HELD | QUOTED | WON | LOST | NURTURE
  last_touch       INTEGER,
  loss_reason      TEXT,
  gmail_thread_id  TEXT            -- P2
);

CREATE INDEX IF NOT EXISTS idx_trackl_outreach_tenant ON trackl_outreach_status(tenant_id);

-- Stub in P1; P2 fills logic.
CREATE TABLE IF NOT EXISTS trackl_draft_emails (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  agency_id         TEXT NOT NULL REFERENCES trackl_agencies(id) ON DELETE CASCADE,
  contact_email     TEXT NOT NULL,
  subject           TEXT,
  body              TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFTED',  -- DRAFTED | APPROVED | SENT | REPLIED
  sequence_step     INTEGER NOT NULL DEFAULT 1,       -- 1=E1 … 4=E4
  gmail_message_id  TEXT,
  sent_at           INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trackl_drafts_tenant ON trackl_draft_emails(tenant_id);
CREATE INDEX IF NOT EXISTS idx_trackl_drafts_agency ON trackl_draft_emails(agency_id);

-- Review queue — awards whose grantee fuzzy-matches no agency. Never dropped.
CREATE TABLE IF NOT EXISTS trackl_unmatched_awards (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  grantee_name        TEXT NOT NULL,
  state               TEXT,
  program             TEXT NOT NULL,
  amount              INTEGER,
  award_date          TEXT,
  source_url          TEXT NOT NULL,
  resolved_agency_id  TEXT,
  created_at          INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trackl_unmatched_dedupe
  ON trackl_unmatched_awards(tenant_id, grantee_name, program, COALESCE(award_date, ''));
CREATE INDEX IF NOT EXISTS idx_trackl_unmatched_tenant ON trackl_unmatched_awards(tenant_id);
