// Track L (Earmarked Awareness Radar) — enums, types, and guards. Kept free
// of better-sqlite3/fs imports so client bundles can use them (same split as
// pools-types.ts / micro-contracts-types.ts). Spec: GOVSCOUT-TRACK-L.md §1.

// Single-tenant fallback (spec STACK & ACCESS): every row carries tenant_id,
// every query filters on it, so the SaaS migration is a constant swap.
export const TRACK_L_TENANT = "el-consulting";

export const AGENCY_TYPES = [
  "STATE_HEALTH",
  "LOCAL_HEALTH",
  "WATER_SYSTEM",
  "HOUSING",
  "OTHER",
] as const;
export type AgencyType = (typeof AGENCY_TYPES)[number];
export function isAgencyType(s: string): s is AgencyType {
  return (AGENCY_TYPES as readonly string[]).includes(s);
}

export const TIERS = ["DREAM", "STANDARD", "LOW"] as const;
export type Tier = (typeof TIERS)[number];
export function isTier(s: string): s is Tier {
  return (TIERS as readonly string[]).includes(s);
}

export const CONTACT_PRIORITIES = [
  "P1_CLPPP",
  "P2_HEALTH_OFFICER",
  "P3_PIO",
  "P4_GENERIC",
] as const;
export type ContactPriority = (typeof CONTACT_PRIORITIES)[number];
export function isContactPriority(s: string): s is ContactPriority {
  return (CONTACT_PRIORITIES as readonly string[]).includes(s);
}

export const FUNDING_PROGRAMS = [
  "HUD_LHC",
  "HUD_HH",
  "EPA_WIIN",
  "LSLR_STATE",
  "OPIOID",
  "OTHER",
] as const;
export type FundingProgram = (typeof FUNDING_PROGRAMS)[number];
export function isFundingProgram(s: string): s is FundingProgram {
  return (FUNDING_PROGRAMS as readonly string[]).includes(s);
}

export const SIGNAL_TYPES = [
  "AWARD_RECENT",
  "SPEND_DEADLINE",
  "BLOOD_LEAD_ELEVATED",
  "HOUSING_PRE1978",
  "LSLR_MANDATE",
  "NEWS_EVENT",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
export function isSignalType(s: string): s is SignalType {
  return (SIGNAL_TYPES as readonly string[]).includes(s);
}

export const OUTREACH_STAGES = [
  "COLD",
  "SEQUENCED",
  "REPLIED",
  "BRIEFING_SET",
  "BRIEFING_HELD",
  "QUOTED",
  "WON",
  "LOST",
  "NURTURE",
] as const;
export type OutreachStage = (typeof OUTREACH_STAGES)[number];
export function isOutreachStage(s: string): s is OutreachStage {
  return (OUTREACH_STAGES as readonly string[]).includes(s);
}

export const DRAFT_EMAIL_STATUSES = ["DRAFTED", "APPROVED", "SENT", "REPLIED"] as const;
export type DraftEmailStatus = (typeof DRAFT_EMAIL_STATUSES)[number];

export const CONTACT_SOURCES = [
  "NACCHO",
  "ASTHO",
  "CLPPP",
  "HUD_AWARD",
  "DEPT_SITE",
  "CENSUS_XREF",
] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export type HealthAgency = {
  id: string;
  tenantId: string;
  name: string;
  type: AgencyType;
  state: string;
  county: string | null;
  fipsCode: string | null;
  website: string | null;
  procurementThreshold: number | null;
  quoteRequirement: string | null;
  fiscalYearEnd: string | null;
  housingPre1978Pct: number | null;
  bloodLeadElevated: boolean | null;
  score: number;
  reasonCodes: string[];
  tier: Tier;
  snapshotUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TrackLContact = {
  id: string;
  tenantId: string;
  agencyId: string;
  name: string | null;
  title: string | null;
  email: string;
  emailVerified: boolean;
  isGeneric: boolean;
  priority: ContactPriority;
  source: ContactSource;
  sourceUrl: string | null;
};

export type FundingEvent = {
  id: string;
  tenantId: string;
  agencyId: string;
  program: FundingProgram;
  amount: number | null;
  awardDate: string | null;
  spendDeadline: string | null;
  sourceUrl: string;
  rawArchiveKey: string | null;
};

export type TrackLSignal = {
  id: string;
  tenantId: string;
  agencyId: string;
  type: SignalType;
  weight: number;
  observedAt: number;
  sourceUrl: string | null;
  note: string | null;
};

export type UnmatchedAward = {
  id: string;
  tenantId: string;
  granteeName: string;
  state: string | null;
  program: FundingProgram;
  amount: number | null;
  awardDate: string | null;
  sourceUrl: string;
  resolvedAgencyId: string | null;
};

// List-view row: agency + rollups the /track-l table needs (§6).
export type AgencyListRow = HealthAgency & {
  contactCount: number;
  fundingEventCount: number;
  topProgram: FundingProgram | null;
};

export type AgencyDetail = HealthAgency & {
  contacts: TrackLContact[];
  fundingEvents: FundingEvent[];
  signals: TrackLSignal[];
  outreachStage: OutreachStage;
};
