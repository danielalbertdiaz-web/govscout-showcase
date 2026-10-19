// Item 4.5 — non-profit data-source adapter contract.
//
// HYBRID decision (locked): build the free IRS-990 / ProPublica path live behind
// this clean interface, and leave a Candid adapter seam for later. The scanner
// depends only on this interface, never on a concrete source — so swapping in
// Candid (paid) is a config change, not a rewrite.

import type { GrantTheme } from "../ntee-themes";

// A discovered non-profit candidate, normalized across sources.
export type NonprofitCandidate = {
  ein: string | null;
  name: string;
  nteeCode: string | null;
  /** Short mission/program description when the source provides one. */
  missionSummary: string | null;
  city: string | null;
  state: string | null;
  /** Approximate annual revenue/budget in USD when available. */
  revenueUsd: number | null;
  /** Which adapter produced this row — auditability requirement. */
  source: string;
  /** Deep link back to the source record. */
  sourceUrl: string | null;
};

export type NonprofitQuery = {
  themes: GrantTheme[];
  /** Two-letter state codes to bias/restrict to (e.g. ["NJ","FL"]). */
  states?: string[];
  /** Extra free-text from the opportunity to sharpen the search. */
  text?: string;
  limit?: number;
};

export interface NonprofitSource {
  readonly id: string;
  /** Whether this source is configured and usable right now. */
  readonly available: boolean;
  search(query: NonprofitQuery): Promise<NonprofitCandidate[]>;
}
