// Item IRS-1 — IRS Exempt-Organizations Business Master File (BMF) → private-
// foundation reference records (free, public; no key).
//
// The BMF publishes a per-STATE CSV of every exempt org with EIN, NTEE, the
// FOUNDATION code (02/03/04 = private foundation), and asset/income figures —
// the lightweight, authoritative way to enumerate NJ/FL private foundations by
// theme WITHOUT downloading hundreds of MB of raw 990-PF XML. (Grants-paid line
// items live in the 990-PF XML and are a later, targeted enrichment.)
//
// This module is the PURE core: a tolerant CSV parser, the private-foundation +
// theme filters, and the BMF→ReferenceOrg mapper. All network-free and tested.
// The impure fetch/write lives in scripts/ingest-irs-bmf.mts.
//
// BMF source: https://www.irs.gov/pub/irs-soi/eo_<state>.csv

import { inferThemesFromText, themesForNtee, THEME_LABELS, type GrantTheme } from "../ntee-themes";
import type { ReferenceOrg } from "../reference-orgs";

// FOUNDATION codes 02/03/04 = private operating + non-operating foundations.
export const BMF_PRIVATE_FOUNDATION_CODES = new Set(["02", "03", "04"]);

// Name-level fallback when NTEE is missing/generic — keeps the ingest tied to
// Acme's behavioral-health / SUD mission.
const NAME_THEME_TERMS = [
  "substance",
  "addiction",
  "recovery",
  "behavioral",
  "mental health",
  "opioid",
  "overdose",
  "prevention",
  "reentry",
  "harm reduction",
];

export type BmfRow = {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  foundation: string;
  nteeCode: string | null;
  assetAmt: number | null;
  incomeAmt: number | null;
  revenueAmt: number | null;
};

// Minimal quote-aware CSV line splitter (BMF rarely quotes, but org names can
// carry commas). Handles "" escaping inside quoted fields.
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out;
}

function numOrNull(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

// Parse the BMF CSV (header-driven, tolerant). Skips rows missing EIN or NAME.
export function parseBmfCsv(text: string): BmfRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const idx = (name: string) => header.indexOf(name);
  const iEin = idx("EIN");
  const iName = idx("NAME");
  const iCity = idx("CITY");
  const iState = idx("STATE");
  const iFdn = idx("FOUNDATION");
  const iNtee = idx("NTEE_CD");
  const iAsset = idx("ASSET_AMT");
  const iIncome = idx("INCOME_AMT");
  const iRev = idx("REVENUE_AMT");
  if (iEin < 0 || iName < 0) return [];

  const out: BmfRow[] = [];
  for (let r = 1; r < lines.length; r++) {
    const c = parseCsvLine(lines[r]);
    const ein = (c[iEin] ?? "").replace(/\D/g, "");
    const name = (c[iName] ?? "").trim();
    if (!ein || !name) continue;
    out.push({
      ein,
      name,
      city: iCity >= 0 ? strOrNull(c[iCity]) : null,
      state: iState >= 0 ? strOrNull(c[iState]) : null,
      foundation: (c[iFdn] ?? "").trim(),
      nteeCode: iNtee >= 0 ? strOrNull(c[iNtee]) : null,
      assetAmt: iAsset >= 0 ? numOrNull(c[iAsset]) : null,
      incomeAmt: iIncome >= 0 ? numOrNull(c[iIncome]) : null,
      revenueAmt: iRev >= 0 ? numOrNull(c[iRev]) : null,
    });
  }
  return out;
}

export function isPrivateFoundation(row: BmfRow): boolean {
  return BMF_PRIVATE_FOUNDATION_CODES.has(row.foundation);
}

// Themes for a row: prefer the NTEE map, fall back to inferring from the name.
export function bmfRowThemes(row: BmfRow): GrantTheme[] {
  const fromNtee = themesForNtee(row.nteeCode);
  if (fromNtee.length) return fromNtee;
  return inferThemesFromText(row.name);
}

// Theme-relevant = its NTEE maps to a theme OR its name carries a mission term.
// Keeps the ingest focused on Acme's themes instead of every NJ/FL foundation.
export function isThemeRelevant(row: BmfRow): boolean {
  if (themesForNtee(row.nteeCode).length) return true;
  const hay = row.name.toLowerCase();
  return NAME_THEME_TERMS.some((t) => hay.includes(t));
}

// BMF names are ALL CAPS — title-case for display, preserving short acronyms.
export function titleCaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, ch: string) => ch.toUpperCase())
    .replace(/\b(Llc|Inc|Pf|Usa|Nj|Fl|Of|And|For|The)\b/g, (m) => {
      const upper = m.toUpperCase();
      return ["USA", "NJ", "FL", "LLC"].includes(upper) ? upper : m.toLowerCase();
    });
}

const STATE_NAMES: Record<string, string> = { NJ: "New Jersey", FL: "Florida" };

function fmtMoney(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

// Map a private-foundation BMF row → a ReferenceOrg (kind "private_foundation").
export function bmfRowToReferenceOrg(row: BmfRow): ReferenceOrg {
  const themes = bmfRowThemes(row);
  const focusAreas = themes.map((t) => THEME_LABELS[t]);
  const stateAbbr = (row.state ?? "").toUpperCase();
  const geography = STATE_NAMES[stateAbbr] ?? (row.state || null);
  // BMF rows often carry placeholder figures ($1, $100). Below $1K the number
  // is bookkeeping noise, not capacity — treat as unknown instead of rendering
  // "Assets ~$1; est. annual giving ~$0" in the UI.
  const assets = row.assetAmt && row.assetAmt >= 1_000 ? row.assetAmt : null;

  const noteParts: string[] = ["Private foundation (IRS BMF)."];
  if (assets != null) {
    noteParts.push(`Assets ~${fmtMoney(assets)}; est. annual giving ~${fmtMoney(Math.round(assets * 0.05))}.`);
  }
  if (row.nteeCode) noteParts.push(`NTEE ${row.nteeCode}.`);
  if (row.city) noteParts.push(`${titleCaseName(row.city)}, ${stateAbbr}.`);

  return {
    id: `pf-${row.ein}`,
    kind: "private_foundation",
    name: titleCaseName(row.name),
    focusAreas,
    geography,
    sourceUrl: `https://projects.propublica.org/nonprofits/organizations/${row.ein}`,
    note: noteParts.join(" "),
    amountUsd: assets,
    year: null,
    ein: row.ein,
  };
}

export type BmfIngestResult = {
  total: number; // rows parsed
  privateFoundations: number; // private foundations
  themeRelevant: number; // kept (private + on-theme)
  orgs: ReferenceOrg[];
};

// Full pipeline for one state's BMF text: parse → keep private + on-theme →
// map → de-dupe by EIN. Sorted by assets desc so the biggest funders lead.
export function bmfToFoundations(text: string): BmfIngestResult {
  const rows = parseBmfCsv(text);
  const pf = rows.filter(isPrivateFoundation);
  const kept = pf.filter(isThemeRelevant);
  const seen = new Set<string>();
  const orgs: ReferenceOrg[] = [];
  for (const row of kept) {
    if (seen.has(row.ein)) continue;
    seen.add(row.ein);
    orgs.push(bmfRowToReferenceOrg(row));
  }
  orgs.sort((a, b) => (b.amountUsd ?? 0) - (a.amountUsd ?? 0));
  return { total: rows.length, privateFoundations: pf.length, themeRelevant: orgs.length, orgs };
}
