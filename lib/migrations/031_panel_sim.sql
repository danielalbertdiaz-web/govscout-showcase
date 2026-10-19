-- Panel-Sim backend (spec: GOVSCOUT_PANEL_SIM_SPEC.md) — reusable reaction-panel /
-- Monte Carlo runs over arbitrary artifacts (cold emails, decks, proposals).
-- Strictly additive: pure CREATEs, no touches to existing tables. Conventions
-- per this repo: snake_case, TEXT ids, INTEGER ms timestamps, JSON-in-TEXT.

CREATE TABLE IF NOT EXISTS ps_runs (
  id                  TEXT PRIMARY KEY,
  user_email          TEXT NOT NULL,
  label               TEXT NOT NULL,
  funnel              TEXT NOT NULL,              -- funnel key, e.g. 'coldemail-deck'
  funnel_stages_json  TEXT NOT NULL DEFAULT '[]', -- json array of stage keys, frozen at run time
  panel_spec          TEXT,                       -- demographic spec the personas were built from
  artifacts_json      TEXT NOT NULL DEFAULT '[]', -- json array of {name, path, chars}
  backend             TEXT NOT NULL DEFAULT 'native', -- PanelBackend id: 'native' | 'ingest' | (later) 'mirofish'
  model               TEXT,                       -- LLM used for personas/decisions (null for ingested runs)
  n_personas          INTEGER NOT NULL DEFAULT 0,
  iterations          INTEGER NOT NULL DEFAULT 1000,
  seed                INTEGER NOT NULL DEFAULT 42,
  status              TEXT NOT NULL DEFAULT 'created', -- created | running | complete | failed
  error               TEXT,
  source_note         TEXT,                       -- provenance, esp. for ingested legacy runs
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ps_runs_user ON ps_runs(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ps_runs_status ON ps_runs(status);

CREATE TABLE IF NOT EXISTS ps_personas (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES ps_runs(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,        -- 1-based position in the panel
  name         TEXT NOT NULL,
  role         TEXT,
  jurisdiction TEXT,
  profile      TEXT,                    -- full prose profile
  traits_json  TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_personas_natural ON ps_personas(run_id, idx);

CREATE TABLE IF NOT EXISTS ps_stage_decisions (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES ps_runs(id) ON DELETE CASCADE,
  persona_id  TEXT NOT NULL REFERENCES ps_personas(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,            -- stage key from the run's funnel
  stage_idx   INTEGER NOT NULL,
  probability REAL NOT NULL,            -- P(advance past stage | reached it), clamped 0..1
  verdict     TEXT,                     -- short judgment ('works'|'neutral'|'backfires'|free text)
  verbatim    TEXT,                     -- one-line persona quote
  detail_json TEXT,                     -- per-element reactions; {derived:true,...} for ingested estimates
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_decisions_natural ON ps_stage_decisions(persona_id, stage);
CREATE INDEX IF NOT EXISTS idx_ps_decisions_run ON ps_stage_decisions(run_id);

CREATE TABLE IF NOT EXISTS ps_reports (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL UNIQUE REFERENCES ps_runs(id) ON DELETE CASCADE,
  aggregate_json   TEXT NOT NULL DEFAULT '{}', -- AggregateReport
  monte_carlo_json TEXT NOT NULL DEFAULT '{}', -- MonteCarloResult (per-stage means + CIs)
  report_md        TEXT,                       -- rendered human report
  decision_id      TEXT,                       -- decision_queue id filed for this run (advisory gate)
  created_at       INTEGER NOT NULL
);
