/**
 * Item 5.3 — State / county opioid-settlement board catalogue.
 *
 * The load-bearing, network-free piece of the settlement-board monitor. The
 * national opioid settlements (Distributors / J&J / pharmacies) push money out
 * through ~3,000 state and local abatement bodies, each on its own cadence and
 * each publishing decisions as irregular PDFs, board minutes, or dashboards.
 * For a SUD-focused shop with a NJ/FL footprint and the Dr. Reed
 * partnership, this is a large untapped, *non-competitive* pool.
 *
 * This module is a curated registry — pure data + pure helpers, no fs / db /
 * network — so it can be exhaustively unit-tested for COVERAGE (all 21 NJ
 * counties incl. the existing Harbor watcher + ≥10 priority states) and for the
 * NJ→FL geography bias. The impure orchestration (crawl + ingest + quarterly
 * health probe) lives in `lib/settlement-scan.ts`, which turns these boards
 * into the same `WatchTarget` shape the Apify watcher already consumes.
 *
 * Settlement opportunities are tagged `funding_source: opioid_settlement` (see
 * `OPIOID_SETTLEMENT_FUNDING_SOURCE` / `settlementNotes`). These are direct
 * abatement disbursements, NOT federal competitive grants — the NAICS /
 * certification / federal-eligibility scoring criteria don't apply the same
 * way, so the tag marks them for the settlement triage path. (NOTE: the current
 * `computeStrategicScore` only hard-disqualifies on expired deadline, so there
 * is no active federal-eligibility *filter* to bypass today — the tag is a
 * forward-looking marker carried in each item's notes. Flagged in STATUS.)
 *
 * URLs/cadences are best-effort and verified at the end-of-sprint live
 * back-test (per the gate-override). The catalogue is the contract; the live
 * crawl lights up the same way the SAM.gov / Candid seams do.
 */

export type SettlementBoardLevel = "county" | "state";

export type SettlementBoard = {
  /** stable slug — dedup key, paneContextId, and WatchTarget.sourceId */
  id: string;
  name: string;
  level: SettlementBoardLevel;
  /** 2-letter postal code */
  state: string;
  /** present for county-level boards */
  county?: string;
  /** primary dashboard / fund landing page to crawl */
  dashboardUrl: string;
  /** RSS or email-subscription feed where the board publishes one */
  rssUrl?: string;
  /** minutes/agenda/PDF page used when there's no dashboard or RSS */
  scrapeFallbackUrl?: string;
  /** known disbursement cadence (free text) */
  cadence: string;
  /** named decision-makers where public; [] when not published */
  decisionMakers: string[];
  /** 1 = highest strategic priority */
  priority: number;
  notes?: string;
};

// ---- Geography ------------------------------------------------------------

/** All 21 New Jersey counties. */
export const NJ_COUNTIES = [
  "Atlantic",
  "Bergen",
  "Burlington",
  "Camden",
  "Cape May",
  "Cumberland",
  "Essex",
  "Gloucester",
  "Hudson",
  "Hunterdon",
  "Mercer",
  "Middlesex",
  "Monmouth",
  "Morris",
  "Ocean",
  "Passaic",
  "Salem",
  "Somerset",
  "Sussex",
  "Union",
  "Warren",
] as const;
export type NJCounty = (typeof NJ_COUNTIES)[number];

/** Priority NJ counties (Harbor already monitored — the anchor). */
export const NJ_PRIORITY_COUNTIES: NJCounty[] = [
  "Hudson",
  "Essex",
  "Bergen",
  "Passaic",
  "Union",
  "Middlesex",
  "Mercer",
  "Camden",
];

/** ≥10 priority states (NJ/FL home turf first, then high-population SUD spend). */
export const PRIORITY_STATES = [
  "NJ",
  "NY",
  "PA",
  "FL",
  "OH",
  "MI",
  "CA",
  "TX",
  "MA",
  "WA",
] as const;
export type PriorityState = (typeof PRIORITY_STATES)[number];

/** Home states — bias candidates here first (mirrors partner-fit HOME_STATES). */
export const HOME_STATES = ["NJ", "FL"] as const;

export const OPIOID_SETTLEMENT_FUNDING_SOURCE = "opioid_settlement";

// ---- County boards (all 21 NJ counties) -----------------------------------

const NJ_COUNTY_MINUTES = (county: string) =>
  `https://www.${county.toLowerCase().replace(/\s+/g, "")}countynj.gov/`;

function njCounty(
  county: NJCounty,
  priority: number,
  extras: Partial<SettlementBoard> = {},
): SettlementBoard {
  const slug = `nj_${county.toLowerCase().replace(/\s+/g, "_")}`;
  return {
    id: slug,
    name: `${county} County Opioid Settlement (NJ)`,
    level: "county",
    state: "NJ",
    county,
    dashboardUrl: extras.dashboardUrl ?? NJ_COUNTY_MINUTES(county),
    scrapeFallbackUrl: extras.scrapeFallbackUrl ?? NJ_COUNTY_MINUTES(county),
    cadence: extras.cadence ?? "Annual abatement plan + periodic commissioner-board minutes",
    decisionMakers: extras.decisionMakers ?? [],
    priority,
    ...extras,
  };
}

export const NJ_COUNTY_BOARDS: SettlementBoard[] = [
  // ---- Priority counties (all 21 NJ counties, public registry) ----
  njCounty("Hudson", 1, {
    dashboardUrl: "https://www.hudsoncountynj.org/opioid-settlement/",
    cadence: "Quarterly advisory-committee meetings; annual NJ ORRF report",
    decisionMakers: ["Hudson County Board of Commissioners", "Dept. of Family Services"],
    notes: "Public settlement dashboard.",
  }),
  njCounty("Essex", 1, {
    dashboardUrl: "https://www.essexcountynj.org/",
    decisionMakers: ["Essex County Board of Commissioners"],
  }),
  njCounty("Bergen", 1, {
    dashboardUrl: "https://www.co.bergen.nj.us/",
  }),
  njCounty("Passaic", 1, {
    dashboardUrl: "https://www.passaiccountynj.org/",
  }),
  njCounty("Union", 1, {
    dashboardUrl: "https://www.ucnj.org/",
  }),
  njCounty("Middlesex", 1, {
    dashboardUrl: "https://www.middlesexcountynj.gov/",
  }),
  njCounty("Mercer", 1, {
    dashboardUrl: "https://www.mercercounty.org/",
  }),
  njCounty("Camden", 1, {
    dashboardUrl: "https://www.camdencounty.com/",
  }),
  // ---- Remaining 13 NJ counties ----
  njCounty("Atlantic", 3),
  njCounty("Burlington", 3),
  njCounty("Cape May", 3, { dashboardUrl: "https://www.capemaycountynj.gov/" }),
  njCounty("Cumberland", 3),
  njCounty("Gloucester", 3),
  njCounty("Hunterdon", 3),
  njCounty("Monmouth", 3, { dashboardUrl: "https://www.visitmonmouth.com/" }),
  njCounty("Morris", 3),
  njCounty("Ocean", 3),
  njCounty("Salem", 3),
  njCounty("Somerset", 3, { dashboardUrl: "https://www.co.somerset.nj.us/" }),
  njCounty("Sussex", 3),
  njCounty("Warren", 3),
];

// ---- State boards (≥10 priority states) -----------------------------------

export const STATE_BOARDS: SettlementBoard[] = [
  {
    id: "nj_state_orrf",
    name: "NJ Opioid Recovery & Remediation Fund Advisory Council",
    level: "state",
    state: "NJ",
    dashboardUrl: "https://www.nj.gov/governor/admin/about/opioid/",
    scrapeFallbackUrl: "https://www.nj.gov/humanservices/dmhas/initiatives/opioid/",
    cadence: "Annual ORRF spending plan; council meetings ~quarterly",
    decisionMakers: ["NJ Dept. of Human Services (DMHAS)", "ORRF Advisory Council"],
    priority: 1,
    notes: "Home state. Statewide abatement plan governs the 21 county sub-allocations.",
  },
  {
    id: "fl_state",
    name: "Florida Opioid Settlement (Florida Statewide & Regional Funds)",
    level: "state",
    state: "FL",
    dashboardUrl: "https://www.myfloridalegal.com/opioids",
    scrapeFallbackUrl: "https://www.floridahealth.gov/programs-and-services/prevention/opioids/",
    cadence: "Statewide + regional fund disbursements; annual reporting",
    decisionMakers: ["FL Attorney General", "FL Dept. of Children & Families"],
    priority: 1,
    notes: "Home state.",
  },
  {
    id: "ny_state_oasas",
    name: "New York Opioid Settlement Fund (OASAS Advisory Board)",
    level: "state",
    state: "NY",
    dashboardUrl: "https://oasas.ny.gov/opioid-settlement-fund",
    cadence: "Annual board recommendations; RFAs issued through OASAS",
    decisionMakers: ["NY OASAS", "Opioid Settlement Fund Advisory Board"],
    priority: 2,
  },
  {
    id: "pa_state_trust",
    name: "Pennsylvania Opioid Misuse & Addiction Abatement Trust",
    level: "state",
    state: "PA",
    dashboardUrl: "https://www.paopioidtrust.org/",
    cadence: "Annual county certification; trust board meetings",
    decisionMakers: ["PA Opioid Misuse & Addiction Abatement Trust"],
    priority: 2,
  },
  {
    id: "oh_state_oneohio",
    name: "OneOhio Recovery Foundation",
    level: "state",
    state: "OH",
    dashboardUrl: "https://oneohio.org/",
    rssUrl: "https://oneohio.org/news/feed/",
    cadence: "Foundation + 19 regional boards; rolling RFPs",
    decisionMakers: ["OneOhio Recovery Foundation Board", "19 Regional Boards"],
    priority: 2,
  },
  {
    id: "mi_state",
    name: "Michigan Opioid Advisory Commission",
    level: "state",
    state: "MI",
    dashboardUrl: "https://www.michigan.gov/opioids/category-settlement",
    cadence: "Annual legislative appropriation; commission meetings",
    decisionMakers: ["MI Opioid Advisory Commission", "MDHHS"],
    priority: 2,
  },
  {
    id: "ca_state",
    name: "California Opioid Settlements (DHCS)",
    level: "state",
    state: "CA",
    dashboardUrl: "https://www.dhcs.ca.gov/opioid-settlements",
    cadence: "Statewide + local allocations; periodic DHCS grant rounds",
    decisionMakers: ["CA Dept. of Health Care Services"],
    priority: 2,
  },
  {
    id: "tx_state",
    name: "Texas Opioid Abatement Fund Council",
    level: "state",
    state: "TX",
    dashboardUrl: "https://oag.my.site.com/datcag/s/texas-opioid-abatement-fund",
    cadence: "Council-approved regional disbursements; periodic RFPs",
    decisionMakers: ["TX Opioid Abatement Fund Council"],
    priority: 3,
  },
  {
    id: "ma_state",
    name: "Massachusetts Opioid Recovery & Remediation Fund",
    level: "state",
    state: "MA",
    dashboardUrl: "https://www.mass.gov/opioid-recovery-and-remediation-fund",
    cadence: "Annual fund report; advisory-council meetings",
    decisionMakers: ["MA Opioid Recovery & Remediation Fund Advisory Council"],
    priority: 3,
  },
  {
    id: "wa_state",
    name: "Washington State Opioid Settlement (HCA)",
    level: "state",
    state: "WA",
    dashboardUrl: "https://www.hca.wa.gov/about-hca/programs-and-initiatives/behavioral-health-recovery/opioid-settlement",
    cadence: "State + local government allocations; periodic HCA funding rounds",
    decisionMakers: ["WA Health Care Authority"],
    priority: 3,
  },
];

export const ALL_SETTLEMENT_BOARDS: SettlementBoard[] = [
  ...STATE_BOARDS,
  ...NJ_COUNTY_BOARDS,
];

// ---- Pure helpers ----------------------------------------------------------

export function boardsForState(state: string): SettlementBoard[] {
  const s = state.toUpperCase();
  return ALL_SETTLEMENT_BOARDS.filter((b) => b.state.toUpperCase() === s);
}

export function priorityBoards(maxPriority = 1): SettlementBoard[] {
  return ALL_SETTLEMENT_BOARDS.filter((b) => b.priority <= maxPriority);
}

/** NJ first (0), then FL (1), then everything else (2). */
export function geographyBiasRank(state: string): number {
  const s = state.toUpperCase();
  const idx = (HOME_STATES as readonly string[]).indexOf(s);
  return idx === -1 ? HOME_STATES.length : idx;
}

/**
 * Discovery order: home-state bias, then strategic priority, then name. Used by
 * the scanner so NJ/FL boards crawl first and surface at the top of triage.
 */
export function orderedBoards(boards: SettlementBoard[] = ALL_SETTLEMENT_BOARDS): SettlementBoard[] {
  return [...boards].sort((a, b) => {
    const g = geographyBiasRank(a.state) - geographyBiasRank(b.state);
    if (g !== 0) return g;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The structured marker stamped into each ingested scout_item's `notes`. JSON
 * so downstream/manual triage can detect settlement items and skip the
 * federal-grant assumptions. Carries the board provenance + cadence.
 */
export function settlementNotes(board: SettlementBoard, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    funding_source: OPIOID_SETTLEMENT_FUNDING_SOURCE,
    board_id: board.id,
    board_name: board.name,
    level: board.level,
    state: board.state,
    county: board.county ?? null,
    cadence: board.cadence,
    decision_makers: board.decisionMakers,
    ...extra,
  });
}

/** True if a scout_item notes blob is an opioid-settlement item. */
export function isSettlementNotes(notes: string | null | undefined): boolean {
  if (!notes) return false;
  try {
    const parsed = JSON.parse(notes) as { funding_source?: unknown };
    return parsed.funding_source === OPIOID_SETTLEMENT_FUNDING_SOURCE;
  } catch {
    return notes.includes(OPIOID_SETTLEMENT_FUNDING_SOURCE);
  }
}

// ---- Coverage self-check (asserted by tests) -------------------------------

export type CoverageReport = {
  njCounties: number;
  njCountiesMissing: string[];
  njPriorityCovered: boolean;
  states: number;
  statesMissing: string[];
  total: number;
};

export function coverageReport(): CoverageReport {
  const njCovered = new Set(NJ_COUNTY_BOARDS.map((b) => b.county));
  const njMissing = NJ_COUNTIES.filter((c) => !njCovered.has(c));
  const stateCovered = new Set(STATE_BOARDS.map((b) => b.state.toUpperCase()));
  const statesMissing = PRIORITY_STATES.filter((s) => !stateCovered.has(s));
  const njPriorityCovered = NJ_PRIORITY_COUNTIES.every((c) => njCovered.has(c));
  return {
    njCounties: njCovered.size,
    njCountiesMissing: njMissing,
    njPriorityCovered,
    states: stateCovered.size,
    statesMissing,
    total: ALL_SETTLEMENT_BOARDS.length,
  };
}
