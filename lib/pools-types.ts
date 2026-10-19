// Pure types + constants shared by server (db.ts) and client (pools UI).
// MUST NOT import anything that pulls server-only modules (fs,
// better-sqlite3, etc.) — this file is consumed by client bundles.

export const POOL_STATUSES = [
  "discovered",
  "researched",
  "engaged",
  "in-proposal",
  "won",
  "lost",
] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];

export function isPoolStatus(s: string): s is PoolStatus {
  return (POOL_STATUSES as readonly string[]).includes(s);
}

export type FundingPool = {
  id: string;
  userEmail: string;
  rank: number | null;
  name: string;
  source: string | null;
  agency: string | null;
  jurisdiction: string | null;
  status: PoolStatus;
  playType: string | null;
  allocatedAmount: string | null;
  unspentAmount: string | null;
  deadlineDate: string | null;
  deadlineLabel: string | null;
  fitSummary: string | null;
  wedge: string | null;
  nextAction: string | null;
  notes: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};
