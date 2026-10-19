/**
 * Track L §2/§4 — HUD Lead Hazard Control / Healthy Homes awards via the
 * USAspending.gov API (free, public, no key).
 * Run: node --import tsx scripts/track-l/ingest-hud-awards.mts [--since=2020-10-01]
 *
 * Assistance-listing numbers verified live 2026-07-22 against
 * /api/v2/autocomplete/cfda/ (spec flagged "believed 14.900-series, verify"):
 *   HUD_LHC: 14.900 Lead Hazard Reduction · 14.905 LHR Demonstration ·
 *            14.912 Capacity Building · 14.920 High Risk Areas · 14.888 LBP Capital Fund
 *   HUD_HH:  14.901 HH Weatherization · 14.906 HH Technical Studies ·
 *            14.913 HH Production · 14.922 Lead-Safe & HH Financing Demo
 *
 * Matching: fuzzy against existing agencies (state-scoped). A clear
 * city/county/state government grantee with no match becomes a new agency
 * (that IS the source data, not a guess); anything ambiguous (nonprofits,
 * universities) goes to trackl_unmatched_awards — never dropped.
 */
import {
  upsertAgency,
  upsertFundingEvent,
  findAgencyByFuzzyName,
  insertUnmatchedAward,
} from "../../lib/track-l";
import type { AgencyType, FundingProgram } from "../../lib/track-l-types";
import { apiFetch, archiveRaw } from "../../lib/track-l-ingest";

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "true"] : [a, "true"];
  }),
);
const since = args.get("since") ?? "2020-10-01";

const PROGRAMS: Array<{ cfda: string; program: FundingProgram; label: string }> = [
  { cfda: "14.900", program: "HUD_LHC", label: "Lead Hazard Reduction" },
  { cfda: "14.905", program: "HUD_LHC", label: "LHR Demonstration" },
  { cfda: "14.912", program: "HUD_LHC", label: "LHC Capacity Building" },
  { cfda: "14.920", program: "HUD_LHC", label: "LHC High Risk Areas" },
  { cfda: "14.888", program: "HUD_LHC", label: "LBP Capital Fund" },
  { cfda: "14.901", program: "HUD_HH", label: "HH Weatherization Demo" },
  { cfda: "14.906", program: "HUD_HH", label: "HH Technical Studies" },
  { cfda: "14.913", program: "HUD_HH", label: "HH Production" },
  { cfda: "14.922", program: "HUD_HH", label: "Lead-Safe & HH Financing" },
];

type AwardRow = {
  "Award ID": string;
  "Recipient Name": string;
  "Start Date": string | null;
  "End Date": string | null;
  "Award Amount": number | null;
  "Place of Performance State Code": string | null;
  "CFDA Number": string;
  generated_internal_id: string;
};

/** Government-entity classifier: these grantee names denote the public agency
 * itself, so creating the agency is faithful ingestion. */
const STATE_NAME_RE =
  /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/;

function govEntityType(name: string): AgencyType | null {
  const n = name.toLowerCase();
  if (/\b(health department|department of health|board of health|public health|department of health services)\b/.test(n)) {
    return /\b(state|commonwealth) of\b/.test(n) || /^(state|commonwealth)\b/.test(n) || STATE_NAME_RE.test(n)
      ? "STATE_HEALTH"
      : "LOCAL_HEALTH";
  }
  if (/\bhousing authority\b|\bdepartment of housing\b|\bcommunity development\b/.test(n)) return "HOUSING";
  if (/\bwater\b.*\b(district|authority|department)\b/.test(n)) return "WATER_SYSTEM";
  if (/^(city|county|town|village|borough|parish|municipality) of\b/.test(n)) return "OTHER";
  if (/\bcounty$/.test(n) || /^the\b.*\bcounty\b/.test(n)) return "OTHER";
  if (/^(state|commonwealth) of\b/.test(n)) return "OTHER";
  return null;
}

function cleanRecipientName(name: string): string {
  return name
    .replace(/,\s*(the|inc\.?|llc)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function fetchAwardPage(cfda: string, page: number): Promise<{ results: AwardRow[]; hasNext: boolean; raw: string }> {
  const res = await apiFetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filters: {
        award_type_codes: ["02", "03", "04", "05"],
        program_numbers: [cfda],
        time_period: [{ start_date: since, end_date: new Date().toISOString().slice(0, 10) }],
      },
      fields: [
        "Award ID", "Recipient Name", "Start Date", "End Date", "Award Amount",
        "Place of Performance State Code", "CFDA Number",
      ],
      sort: "Award Amount",
      order: "desc",
      limit: 100,
      page,
    }),
  });
  if (!res.ok) throw new Error(`USAspending HTTP ${res.status}`);
  const raw = await res.text();
  const body = JSON.parse(raw) as { results: AwardRow[]; page_metadata?: { hasNext?: boolean } };
  return { results: body.results ?? [], hasNext: Boolean(body.page_metadata?.hasNext), raw };
}

let events = 0;
let newAgencies = 0;
let unmatched = 0;

for (const p of PROGRAMS) {
  let page = 1;
  let hasNext = true;
  let count = 0;
  while (hasNext) {
    const { results, hasNext: next, raw } = await fetchAwardPage(p.cfda, page);
    if (results.length > 0) {
      const key = archiveRaw("usaspending", `cfda-${p.cfda}-page-${page}.json`, raw);
      for (const a of results) {
        const grantee = cleanRecipientName(a["Recipient Name"] ?? "");
        const state = a["Place of Performance State Code"] ?? null;
        if (!grantee) continue;
        const sourceUrl = `https://www.usaspending.gov/award/${a.generated_internal_id}`;
        let agency = findAgencyByFuzzyName(grantee, state);
        if (!agency && state) {
          const t = govEntityType(grantee);
          if (t) {
            const countyM =
              grantee.match(/^(?:The )?County Of (.+)$/i) ??
              grantee.match(/^(.+?) County(?: Government| Health.*)?$/i);
            agency = upsertAgency({
              name: grantee,
              state,
              type: t,
              county: countyM?.[1]?.trim() ?? null,
            }).agency;
            newAgencies++;
          }
        }
        if (!agency) {
          insertUnmatchedAward({
            granteeName: grantee,
            state,
            program: p.program,
            amount: a["Award Amount"] == null ? null : Math.round(a["Award Amount"]),
            awardDate: a["Start Date"],
            sourceUrl,
          });
          unmatched++;
          continue;
        }
        upsertFundingEvent({
          agencyId: agency.id,
          program: p.program,
          amount: a["Award Amount"] == null ? null : Math.round(a["Award Amount"]),
          awardDate: a["Start Date"],
          spendDeadline: a["End Date"],
          sourceUrl,
          rawArchiveKey: key,
        });
        events++;
      }
      count += results.length;
    }
    hasNext = next;
    page++;
  }
  console.log(`${p.cfda} ${p.label}: ${count} awards`);
}

console.log(`hud-awards done: ${events} funding events, ${newAgencies} agencies created from grantees, ${unmatched} → unmatched queue`);
