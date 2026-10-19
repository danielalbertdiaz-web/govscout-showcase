// Program-category classification for the grants workspaces (2026-08-26).
//
// Client-safe and pure — no db import, so the client-side workspace view can
// use it directly. Each client gets its OWN taxonomy: categories are how the
// client thinks about their program lines (Riverside: WIC/nutrition, LIHEAP,
// Head Start...; Northstar: safety training vs work reentry), so a shared list
// would misdescribe both.
//
// Derived at render time from title+description rather than stored: the
// scanner payloads carry no category field, keyword rules will improve, and
// a stored value would freeze yesterday's classifier output. If a category
// ever becomes a human decision (overrides), THEN it earns a column.
//
// ORDER MATTERS: first match wins, so the more specific categories sit above
// the broader ones (e.g. "opioid" before generic "health").

export type GrantCategory = {
  key: string;
  label: string;
  pattern: RegExp;
};

const Riverside_CATEGORIES: readonly GrantCategory[] = [
  {
    key: "nutrition",
    label: "Food & Nutrition (WIC/SNAP)",
    pattern:
      /\bWIC\b|\bSNAP\b|nutrition|food (assistance|security|bank|pantry)|pantry|meals?\b|hunger|feeding/i,
  },
  {
    key: "behavioral",
    label: "Behavioral Health & SUD",
    pattern:
      /opioid|substance (use|abuse)|\bSUD\b|overdose|recovery|behavioral health|mental health|stimulant|\bIDRC\b|intoxicated|addiction|\bCCBHC\b/i,
  },
  {
    key: "housing",
    label: "Housing & Homelessness",
    pattern:
      /homeless|housing|eviction|shelter|code blue|transitional living|reentry housing|\bROSS\b|weatheriz|rental assistance|fair housing/i,
  },
  {
    key: "energy",
    label: "Energy Assistance (LIHEAP)",
    pattern: /\bLIHEAP\b|energy assistance|utility assistance|home energy/i,
  },
  {
    // Above workforce/children on purpose: "Refugee ... Employment Services"
    // and "Unaccompanied Alien Children" are immigrant-services programs,
    // not workforce or childcare ones.
    key: "legal",
    label: "Legal, Immigrant & Victim Services",
    pattern:
      /legal (aid|assistance|services|constituent)|deportation|refugee|immigrant|unaccompanied|domestic violence|sexual assault|victim|\bOVW\b/i,
  },
  {
    key: "workforce",
    label: "Workforce Development",
    pattern:
      /\bWIOA\b|\bWDB\b|workforce|career (center|services)|job (training|placement)|employment|apprentice|E&T\b|out-of-school youth|occupational|vocational/i,
  },
  {
    key: "children",
    label: "Children, Youth & Families",
    pattern:
      /head start|child care|childcare|afterschool|after-school|early (childhood|intervention)|youth|children|family|abused parents|basic center|foster/i,
  },
  {
    key: "seniors",
    label: "Seniors & Adult Services",
    pattern: /older americans|senior|aging|adult protective|elder/i,
  },
  {
    key: "health",
    label: "Health Services",
    pattern:
      /\bHIV\b|health|medicaid|screening|\bWISH\b|clinic|medical|telehealth|service area competition|\bSAC\b/i,
  },
  {
    key: "community",
    label: "Community & Economic Development",
    pattern:
      /community (economic|development|solutions|grants)|economic development|\bCSBG\b|security grant|capacity building|nonprofit security/i,
  },
] as const;

const NORTHSTAR_CATEGORIES: readonly GrantCategory[] = [
  {
    // Above training on purpose: Second Chance Act grants fund "training +
    // placement" for justice-involved people — reentry is what the program
    // IS, training is how it does it.
    key: "reentry",
    label: "Work Reentry",
    pattern:
      /reentry|re-entry|second chance|justice[- ]involved|formerly incarcerated|ex-offender|returning citizen|expungement|post-release/i,
  },
  {
    key: "training",
    label: "Safety & Job Training",
    pattern:
      /\bOSHA\b|susan harwood|safety training|job training|vocational training|workforce training|apprentice|certification|occupational safety|training grant|skills training|construction training/i,
  },
  {
    key: "placement",
    label: "Job Placement & Employment Services",
    pattern:
      /job placement|employment (provider|services|outcomes)|vocational rehabilitation|career services|workforce development|staffing|hiring/i,
  },
] as const;

const CATEGORY_SETS: Record<string, readonly GrantCategory[]> = {
  riverside: Riverside_CATEGORIES,
  northstar: NORTHSTAR_CATEGORIES,
};

export const OTHER_CATEGORY = { key: "other", label: "Other" } as const;

/** The category taxonomy for one client's workspace (empty for clients
 * without one yet — the view then shows no chips and one flat group). */
export function categoriesFor(clientId: string): readonly GrantCategory[] {
  return CATEGORY_SETS[clientId] ?? [];
}

/** First matching category key for a grant's text; "other" when none hit. */
export function categorizeGrant(clientId: string, title: string, description?: string | null): string {
  const text = `${title}\n${description ?? ""}`;
  for (const c of categoriesFor(clientId)) {
    if (c.pattern.test(text)) return c.key;
  }
  return OTHER_CATEGORY.key;
}

export function categoryLabel(clientId: string, key: string): string {
  return categoriesFor(clientId).find((c) => c.key === key)?.label ?? OTHER_CATEGORY.label;
}
