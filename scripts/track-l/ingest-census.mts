/**
 * Track L §2/§4 — Census ACS B25034 (year structure built) → pre-1978 housing
 * share per agency.
 * Run: node --import tsx scripts/track-l/ingest-census.mts
 *
 * Variable map verified live 2026-07-22 against
 * api.census.gov/data/2023/acs/acs5/variables.json:
 *   B25034_001E total · 007E 1970-79 · 008E 1960-69 · 009E 1950-59 ·
 *   010E 1940-49 · 011E ≤1939  → pre-1980 share = (007+008+009+010+011)/001.
 * §4 quirk: buckets are decades, so pre-1978 is proxied by pre-1980 — the §3
 * reason code text notes the proxy (see recomputeAgencyScore).
 *
 * Resolution: agencies with a county (parsed from their own name) get their
 * county's figure + FIPS; everything else gets the state figure.
 * Access note (2026-07-22): api.census.gov data queries now 302 to
 * missing_key.html without an API key, so this job uses the keyless
 * data.census.gov table API (ACSDT5Y{year}.B25034; g=010XX00US$0400000 =
 * all states, $0500000 = all counties). Header row carries column ids.
 */
import { getDb } from "../../lib/db";
import { upsertAgency } from "../../lib/track-l";
import { TRACK_L_TENANT } from "../../lib/track-l-types";
import { apiFetch, archiveRaw } from "../../lib/track-l-ingest";

const YEAR = "2023";
const OLD_VARS = ["B25034_007E", "B25034_008E", "B25034_009E", "B25034_010E", "B25034_011E"];

type GeoRow = { name: string; geoId: string; pct: number | null };

async function fetchTable(geoLevel: string, label: string): Promise<GeoRow[]> {
  const url = `https://data.census.gov/api/access/data/table?id=ACSDT5Y${YEAR}.B25034&g=010XX00US$${geoLevel}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`census HTTP ${res.status} for ${label}`);
  const raw = await res.text();
  archiveRaw("census", `b25034-${label}.json`, raw);
  const data = (JSON.parse(raw) as { response: { data: (string | null)[][] } }).response.data;
  const hdr = data[0] as string[];
  const idx = (col: string) => hdr.indexOf(col);
  const iName = idx("NAME");
  const iGeo = idx("GEO_ID");
  const iTotal = idx("B25034_001E");
  const iOlds = OLD_VARS.map(idx);
  return data.slice(1).map((r) => {
    const total = Number(r[iTotal]);
    const old = iOlds.reduce((a, i) => a + (Number(r[i]) || 0), 0);
    return {
      name: String(r[iName]),
      geoId: String(r[iGeo]),
      pct: Number.isFinite(total) && total > 0 ? Math.round((old / total) * 1000) / 10 : null,
    };
  });
}

// State level: NAME = "Ohio", GEO_ID = 0400000US39
const statePct = new Map<string, number>();
for (const r of await fetchTable("0400000", "states")) {
  if (r.pct != null) statePct.set(r.name, r.pct);
}
console.log(`census: ${statePct.size} state rows`);

// County level: NAME = "Mahoning County, Ohio", GEO_ID = 0500000US39099
type CountyRec = { pct: number | null; fips: string };
const countyPct = new Map<string, CountyRec>();
for (const r of await fetchTable("0500000", "counties")) {
  const [county, stateName] = r.name.split(", ");
  if (!county || !stateName) continue;
  countyPct.set(`${county.toLowerCase()}|${stateName}`, {
    pct: r.pct,
    fips: r.geoId.split("US")[1] ?? "",
  });
}
console.log(`census: ${countyPct.size} county rows`);

const STATE_ABBR_TO_NAME: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const db = getDb();
const agencies = db
  .prepare("SELECT id, name, state, county FROM trackl_agencies WHERE tenant_id = ?")
  .all(TRACK_L_TENANT) as Array<{ id: string; name: string; state: string; county: string | null }>;

let countyHits = 0;
let stateFallback = 0;
for (const a of agencies) {
  const stateName = STATE_ABBR_TO_NAME[a.state];
  if (!stateName) continue;
  let applied: number | null = null;
  let fips: string | null = null;
  if (a.county) {
    // county field stores the bare name ("Mahoning"); census NAME appends "County"
    for (const suffix of [" county", " parish", " borough", ""]) {
      const rec = countyPct.get(`${a.county.toLowerCase()}${suffix}|${stateName}`);
      if (rec) {
        applied = rec.pct;
        fips = rec.fips;
        break;
      }
    }
  }
  if (applied == null) {
    applied = statePct.get(stateName) ?? null;
    if (applied != null) stateFallback++;
  } else {
    countyHits++;
  }
  if (applied != null) {
    upsertAgency({ name: a.name, state: a.state, housingPre1978Pct: applied, fipsCode: fips ?? undefined });
  }
}
console.log(`census done: ${countyHits} county-resolved, ${stateFallback} state-fallback, of ${agencies.length} agencies`);
