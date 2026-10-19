// P14 — operator-created scouts. The three shipped verticals live as code in
// scout-profiles.ts (pure); this module adds DB-backed custom profiles the
// operator creates from the UI — typically "save this search as a scout".
// allEnabledProfiles() is the merge point: the scan rail and run-now route
// call it instead of enabledProfiles(), so a custom scout joins every lane
// (foundation, teaming, underspend) on the next run with zero code changes.

import { getDb } from "./db";
import { enabledProfiles, SCOUT_PROFILES, type ScoutProfile } from "./scout-profiles";
import type { GrantTheme } from "./ntee-themes";

export type CustomScout = {
  id: string;
  label: string;
  champion: string;
  keywords: string[];
  naics: string[];
  themes: GrantTheme[];
  enabled: boolean;
  createdAt: number;
};

function ensureTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS custom_scouts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      champion TEXT NOT NULL DEFAULT 'Acme Consulting',
      keywords_json TEXT NOT NULL,
      naics_json TEXT NOT NULL,
      themes_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
}

type Row = {
  id: string;
  label: string;
  champion: string;
  keywords_json: string;
  naics_json: string;
  themes_json: string;
  enabled: number;
  created_at: number;
};

function rowToScout(r: Row): CustomScout {
  return {
    id: r.id,
    label: r.label,
    champion: r.champion,
    keywords: JSON.parse(r.keywords_json),
    naics: JSON.parse(r.naics_json),
    themes: JSON.parse(r.themes_json),
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export function listCustomScouts(): CustomScout[] {
  ensureTable();
  const rows = getDb()
    .prepare("SELECT * FROM custom_scouts ORDER BY created_at DESC")
    .all() as Row[];
  return rows.map(rowToScout);
}

export function createCustomScout(input: {
  label: string;
  keywords: string[];
  naics?: string[];
  themes?: GrantTheme[];
  champion?: string;
}): CustomScout {
  ensureTable();
  const label = input.label.trim().slice(0, 120);
  const keywords = input.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 20);
  if (!label || keywords.length === 0) {
    throw new Error("A scout needs a name and at least one keyword.");
  }
  const naics = (input.naics ?? []).map((n) => n.trim()).filter((n) => /^\d{6}$/.test(n)).slice(0, 20);
  const scout: CustomScout = {
    id: `custom_${crypto.randomUUID().slice(0, 8)}`,
    label,
    champion: (input.champion ?? "Acme Consulting").trim().slice(0, 60) || "Acme Consulting",
    keywords,
    naics,
    themes: input.themes ?? [],
    enabled: true,
    createdAt: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO custom_scouts (id, label, champion, keywords_json, naics_json, themes_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      scout.id,
      scout.label,
      scout.champion,
      JSON.stringify(scout.keywords),
      JSON.stringify(scout.naics),
      JSON.stringify(scout.themes),
      scout.createdAt,
    );
  return scout;
}

export function setCustomScoutEnabled(id: string, enabled: boolean): boolean {
  ensureTable();
  const res = getDb()
    .prepare("UPDATE custom_scouts SET enabled = ? WHERE id = ?")
    .run(enabled ? 1 : 0, id);
  return res.changes > 0;
}

export function deleteCustomScout(id: string): boolean {
  ensureTable();
  return getDb().prepare("DELETE FROM custom_scouts WHERE id = ?").run(id).changes > 0;
}

/** Built-in profile ids — custom scouts may not shadow these. */
export function isBuiltinProfileId(id: string): boolean {
  return SCOUT_PROFILES.some((p) => p.id === id);
}

/** Code-defined verticals + enabled operator-created scouts, one list. */
export function allEnabledProfiles(): ScoutProfile[] {
  const custom = listCustomScouts()
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      label: s.label,
      enabled: true,
      champion: s.champion,
      keywords: s.keywords,
      naics: s.naics,
      themes: s.themes,
    }));
  return [...enabledProfiles(), ...custom];
}
