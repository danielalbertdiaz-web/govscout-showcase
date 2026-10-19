// Item 4.5 — NTEE-code -> grant-theme mapping (THE load-bearing piece).
//
// Pure + fully tested, no IO. The non-profit scanner translates an opportunity's
// funding theme into the IRS NTEE codes worth querying (forward map), and
// classifies a discovered org's NTEE code back into themes for relevance
// scoring (reverse map). Built once, reused by ProPublica/IRS-BMF adapters and
// (later) Candid. Geography is handled separately by the scanner; this module is
// purely the taxonomy bridge.
//
// NTEE primer: a major-group LETTER (F = Mental Health & Crisis Intervention,
// I = Crime & Legal-Related, O = Youth Development, P = Human Services, …) plus
// digits for specificity (F22 = Substance Abuse Treatment). Orgs in the IRS
// Business Master File sometimes carry only a coarse code, so lookups fall back
// exact -> 3-char prefix -> major-group letter.

export const GRANT_THEMES = [
  "substance_use",
  "behavioral_health",
  "reentry",
  "youth",
  "crime_prevention",
  "health",
  "human_services",
] as const;
export type GrantTheme = (typeof GRANT_THEMES)[number];

export function isGrantTheme(s: unknown): s is GrantTheme {
  return typeof s === "string" && (GRANT_THEMES as readonly string[]).includes(s);
}

export const THEME_LABELS: Record<GrantTheme, string> = {
  substance_use: "Substance use & recovery",
  behavioral_health: "Behavioral & mental health",
  reentry: "Reentry & justice-impacted",
  youth: "Youth development & prevention",
  crime_prevention: "Crime & violence prevention",
  health: "Health care",
  human_services: "Human services",
};

// --- exact NTEE-code -> themes ---------------------------------------------
// Specific codes that carry strong, unambiguous theme signal. Keys are upper-
// case NTEE codes. A code can map to more than one theme.
const EXACT: Record<string, GrantTheme[]> = {
  // F — Mental Health & Crisis Intervention
  F20: ["substance_use", "behavioral_health"], // Alcohol/Drug Abuse — prevention & treatment
  F21: ["substance_use"], // Substance Abuse Prevention
  F22: ["substance_use"], // Substance Abuse Treatment
  F30: ["behavioral_health"], // Mental Health Treatment
  F31: ["behavioral_health"], // Psychiatric / Mental Health Hospital
  F32: ["behavioral_health"], // Community Mental Health Centers
  F33: ["behavioral_health"], // Group Home, Mental Health
  F40: ["behavioral_health"], // Hot Lines & Crisis Intervention
  F42: ["behavioral_health"], // Counseling / Support Groups
  F50: ["substance_use", "behavioral_health"], // Addictive Disorders (incl. gambling)
  F60: ["behavioral_health"], // Counseling
  F70: ["behavioral_health"], // Mental Health Disorders
  F80: ["behavioral_health"], // Mental Health Associations (Multipurpose)

  // I — Crime & Legal-Related
  I20: ["crime_prevention"], // Crime Prevention
  I21: ["crime_prevention", "youth"], // Youth Violence Prevention
  I23: ["crime_prevention"], // Drunk Driving Related
  I40: ["reentry"], // Rehabilitation Services for Offenders
  I43: ["reentry"], // Inmate Support
  I44: ["reentry"], // Prison Alternatives
  I70: ["crime_prevention"], // Protection Against Abuse
  I71: ["crime_prevention"], // Spouse Abuse Prevention
  I72: ["crime_prevention", "youth"], // Child Abuse Prevention
  I80: ["reentry"], // Legal Services (offender-adjacent)

  // O — Youth Development
  O20: ["youth"], // Youth Centers / Clubs
  O30: ["youth"], // Adult & Child Matching Programs (mentoring)
  O31: ["youth"], // Big Brothers / Big Sisters
  O50: ["youth"], // Youth Development Programs
  O51: ["youth", "crime_prevention"], // Youth Community Service Clubs
  O52: ["youth"], // Youth Development - Agricultural
  O53: ["youth"], // Youth Development - Business
  O54: ["youth"], // Youth Development - Citizenship
  O55: ["youth"], // Youth Development - Religious Leadership

  // P — Human Services (selected, behavioral/family-adjacent)
  P40: ["human_services"], // Family Services
  P42: ["human_services", "behavioral_health"], // Single Parent Agencies / Services
  P46: ["human_services", "behavioral_health"], // Family Counseling
  P70: ["human_services"], // Residential / Custodial Care
  P73: ["human_services", "behavioral_health"], // Group Homes (non mental-health)
  P80: ["human_services"], // Services to Promote Independence

  // E / G — Health
  E60: ["health"], // Health Support Services
  E70: ["health"], // Public Health
  G70: ["health", "substance_use"], // Diseases of Specific Organs / addiction-adjacent
};

// --- 3-char prefix -> themes (coarse codes) --------------------------------
const PREFIX: Record<string, GrantTheme[]> = {
  F20: ["substance_use", "behavioral_health"],
  F22: ["substance_use"],
};

// --- major-group LETTER -> themes (last-resort fallback) -------------------
const MAJOR_GROUP: Record<string, GrantTheme[]> = {
  F: ["behavioral_health"], // Mental Health & Crisis Intervention
  I: ["crime_prevention"], // Crime & Legal-Related
  O: ["youth"], // Youth Development
  P: ["human_services"], // Human Services
  E: ["health"], // Health Care
  G: ["health"], // Voluntary Health Associations
};

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Themes implied by a single NTEE code. Resolution order: exact code -> known
 * 3-char prefix -> major-group letter. Returns [] for an empty/unknown code so
 * the scanner can treat "no signal" distinctly from "wrong theme".
 */
export function themesForNtee(code: string | null | undefined): GrantTheme[] {
  if (!code) return [];
  const c = normalizeCode(code);
  if (!c) return [];
  if (EXACT[c]) return EXACT[c];
  const p3 = c.slice(0, 3);
  if (PREFIX[p3]) return PREFIX[p3];
  // Try progressively shorter exact matches (e.g. "F205" -> "F20").
  for (let len = Math.min(c.length, 4); len >= 3; len--) {
    const sub = c.slice(0, len);
    if (EXACT[sub]) return EXACT[sub];
  }
  const letter = c[0];
  return MAJOR_GROUP[letter] ?? [];
}

// Reverse index: theme -> the specific NTEE codes most worth querying. Built
// from EXACT so it stays in sync. Used to seed adapter queries (ProPublica's
// `ntee` filter, IRS-BMF code filters).
const THEME_TO_CODES: Record<GrantTheme, string[]> = (() => {
  const out = Object.fromEntries(GRANT_THEMES.map((t) => [t, [] as string[]])) as Record<
    GrantTheme,
    string[]
  >;
  for (const [code, themes] of Object.entries(EXACT)) {
    for (const t of themes) out[t].push(code);
  }
  for (const t of GRANT_THEMES) out[t].sort();
  return out;
})();

/** The NTEE codes most worth querying for a given theme (sorted, de-duped). */
export function nteeCodesForTheme(theme: GrantTheme): string[] {
  return THEME_TO_CODES[theme] ?? [];
}

/** NTEE major-group letter(s) for a theme — coarse query fallback. */
export function nteeMajorGroupsForTheme(theme: GrantTheme): string[] {
  const groups = new Set<string>();
  for (const [letter, themes] of Object.entries(MAJOR_GROUP)) {
    if (themes.includes(theme)) groups.add(letter);
  }
  // Pull the leading letters of exact codes too (covers themes whose only
  // major-group match is indirect, e.g. reentry lives under "I").
  for (const code of nteeCodesForTheme(theme)) groups.add(code[0]);
  return Array.from(groups).sort();
}

// --- text -> themes ---------------------------------------------------------
// Keyword inference so an opportunity title/summary (which carries no NTEE code)
// can be turned into target themes. Substring match, case-insensitive.
const THEME_KEYWORDS: Record<GrantTheme, string[]> = {
  substance_use: [
    "substance use",
    "substance abuse",
    "addiction",
    "opioid",
    "opiate",
    "overdose",
    "drug",
    "alcohol",
    "recovery",
    "sud",
    "naloxone",
    "harm reduction",
    "medication-assisted",
    "mat ",
  ],
  behavioral_health: [
    "behavioral health",
    "mental health",
    "psychiatric",
    "counseling",
    "crisis intervention",
    "suicide",
    "depression",
    "trauma",
    "wellness",
  ],
  reentry: [
    "reentry",
    "re-entry",
    "reintegration",
    "formerly incarcerated",
    "justice-impacted",
    "justice impacted",
    "returning citizens",
    "ex-offender",
    "parole",
    "probation",
    "prison",
    "incarcerat",
  ],
  youth: [
    "youth",
    "adolescent",
    "teen",
    "juvenile",
    "after-school",
    "afterschool",
    "mentoring",
    "young people",
    "at-risk youth",
  ],
  crime_prevention: [
    "crime prevention",
    "violence prevention",
    "gang",
    "delinquency",
    "victim",
    "abuse prevention",
    "community safety",
  ],
  health: ["public health", "health care", "healthcare", "clinic", "fqhc", "wellness center"],
  human_services: [
    "human services",
    "social services",
    "family services",
    "case management",
    "wraparound",
    "supportive housing",
  ],
};

/**
 * Infer target grant themes from free text (opportunity title + summary). Ordered
 * by the canonical theme order. Empty when nothing matches.
 */
export function inferThemesFromText(text: string | null | undefined): GrantTheme[] {
  if (!text) return [];
  const t = text.toLowerCase();
  const hits: GrantTheme[] = [];
  for (const theme of GRANT_THEMES) {
    if (THEME_KEYWORDS[theme].some((kw) => t.includes(kw))) hits.push(theme);
  }
  return hits;
}
