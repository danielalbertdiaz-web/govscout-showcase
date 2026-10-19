// Pure types + constants for Scouts. Safe to import in client bundles.
// MUST NOT pull server-only modules (fs, better-sqlite3, etc.).

export const SCOUT_ITEM_STATUSES = [
  "new",
  "interested",
  "dismissed",
  "promoted",
] as const;
export type ScoutItemStatus = (typeof SCOUT_ITEM_STATUSES)[number];

export function isScoutItemStatus(s: string): s is ScoutItemStatus {
  return (SCOUT_ITEM_STATUSES as readonly string[]).includes(s);
}

// Source classification — bucket the digest item by the agency string we
// extracted heuristically. Used for filtering in the UI.
export const SCOUT_SOURCES = [
  "samhsa",
  "hrsa",
  "cdc",
  "doj",
  "hud",
  "dol",
  "sba",
  "ntia",
  "grants_gov",
  "sam_gov",
  "fed_register",
  "state",
  "county",
  "foundation",
  "lead_portal",
  "earmark",
  "other",
] as const;
export type ScoutSource = (typeof SCOUT_SOURCES)[number];

export function isScoutSource(s: string): s is ScoutSource {
  return (SCOUT_SOURCES as readonly string[]).includes(s);
}

export type ScoutDigest = {
  id: string;
  userEmail: string;
  cronJobId: string;
  cronSessionId: string | null;
  sourceLabel: string;
  ranAtMs: number;
  status: string | null;
  summary: string;
  model: string | null;
  durationMs: number | null;
  ingestedAtMs: number;
};

export type ScoutItem = {
  id: string;
  digestId: string;
  userEmail: string;
  source: ScoutSource;
  title: string;
  agency: string | null;
  deadlineText: string | null;
  fundingText: string | null;
  naics: string | null;
  url: string | null;
  rawText: string;
  status: ScoutItemStatus;
  poolId: string | null;
  savedOpportunityId: string | null;
  notes: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  // A1 fit-scoring (migration 005). null until /api/scouts/score-batch runs.
  score: number | null;
  scoreRationale: string | null;
  scoredAt: number | null;
};

// Whitelist of cron job IDs the user has authorized as Gov Scout intel feeds.
// C7 (no new integrations) — we only consume what's already running on the
// user's machine. The cron output lives in ~/.openclaw/cron/runs/<id>.jsonl.
export const SCOUT_CRON_JOBS: ReadonlyArray<{
  id: string;
  label: string;
}> = [
  {
    id: "e0b41e60-f780-4eeb-9937-75925e1f8f32",
    label: "Gov Scout Daily Digest",
  },
  {
    id: "359b416d-a429-40b1-abc3-d450d9458934",
    label: "Behavioral Health + STREETS NOFO Watch",
  },
  {
    id: "e9dc9dc2-004a-46c4-8503-6aadd3278afb",
    label: "Marketing & Public Awareness Campaign Scout",
  },
];
