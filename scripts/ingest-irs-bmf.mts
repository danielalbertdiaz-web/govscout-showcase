/**
 * Item IRS-1 — bulk ingest NJ/FL private foundations from the IRS BMF into the
 * Reference dataset (data/reference/index.json).
 * Run: node --import tsx scripts/ingest-irs-bmf.mts
 *
 * Fetches the per-state Exempt-Organizations Business Master File, keeps the
 * private foundations (FOUNDATION 02/03/04) that are on Acme's behavioral-health /
 * SUD themes, maps them to ReferenceOrg records, and MERGES them under a new
 * `private_foundations` key — preserving the curated winners + non-profits. The
 * reference loader/normalizer already understands the new key + kind.
 */

import { promises as fs } from "fs";
import path from "path";
import { bmfToFoundations } from "../lib/foundation-sources/irs-bmf";
import type { ReferenceOrg } from "../lib/reference-orgs";

const STATES = ["nj", "fl"];
const BMF_URL = (st: string) => `https://www.irs.gov/pub/irs-soi/eo_${st}.csv`;
const INDEX_PATH = path.join(process.cwd(), "data", "reference", "index.json");

function toSeed(o: ReferenceOrg): Record<string, unknown> {
  return {
    id: o.id,
    name: o.name,
    ein: o.ein,
    geography: o.geography,
    focus_areas: o.focusAreas,
    source_url: o.sourceUrl,
    note: o.note,
    amount_usd: o.amountUsd,
  };
}

console.log(`\n=== IRS BMF → private-foundation reference ingest (NJ/FL) ===`);

const merged = new Map<string, ReferenceOrg>();
for (const st of STATES) {
  process.stdout.write(`fetching ${st.toUpperCase()} BMF… `);
  const res = await fetch(BMF_URL(st), { headers: { accept: "text/csv" } });
  if (!res.ok) {
    console.log(`HTTP ${res.status} — skipped`);
    continue;
  }
  const text = await res.text();
  const { total, privateFoundations, themeRelevant, orgs } = bmfToFoundations(text);
  console.log(`${total} rows · ${privateFoundations} private foundations · ${themeRelevant} on-theme`);
  for (const o of orgs) if (!merged.has(o.ein ?? o.id)) merged.set(o.ein ?? o.id, o);
}

const foundations = [...merged.values()].sort((a, b) => (b.amountUsd ?? 0) - (a.amountUsd ?? 0));
console.log(`\nmerged unique on-theme private foundations: ${foundations.length}`);

// Merge into the existing dataset, preserving curated arrays + metadata.
const raw = await fs.readFile(INDEX_PATH, "utf8");
const data = JSON.parse(raw) as Record<string, unknown>;
data.private_foundations = foundations.map(toSeed);
const meta = (data.metadata ?? {}) as Record<string, unknown>;
meta.private_foundations_source =
  "IRS Exempt-Organizations Business Master File (eo_nj.csv / eo_fl.csv) — private foundations " +
  "(FOUNDATION 02/03/04) filtered to behavioral-health / SUD themes by NTEE + name. Assets/est. " +
  "giving from BMF ASSET_AMT (×5% payout). Re-run scripts/ingest-irs-bmf.mts to refresh.";
meta.private_foundations_ingested_at = new Date().toISOString().slice(0, 10);
data.metadata = meta;

await fs.writeFile(INDEX_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log(`wrote ${foundations.length} private foundations → ${INDEX_PATH}`);

console.log(`\ntop 8 by assets:`);
for (const f of foundations.slice(0, 8)) {
  console.log(`  • ${f.name} [${f.geography ?? "—"}] — ${f.note ?? ""}`);
}
console.log("");
