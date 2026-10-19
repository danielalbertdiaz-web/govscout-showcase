// Item 4.5 — Candid (paid) adapter SEAM.
//
// HYBRID decision (locked): the free ProPublica/IRS-990 path is the live default;
// Candid is left as a clean, interface-compatible seam so it can be switched on
// later WITHOUT touching the scanner. It overlaps the 5.1 foundation decision —
// "don't pay twice": if Candid is purchased for 5.1, this adapter lights up and
// covers org profiles too.
//
// Until a CANDID_API_KEY is configured, `available` is false and `search`
// returns []. The scanner skips unavailable sources, so this is a no-op today.

import type { NonprofitCandidate, NonprofitQuery, NonprofitSource } from "./types";

function candidConfigured(): boolean {
  return Boolean(process.env.CANDID_API_KEY?.trim());
}

export const candidSource: NonprofitSource = {
  id: "candid",
  get available() {
    return candidConfigured();
  },
  async search(_query: NonprofitQuery): Promise<NonprofitCandidate[]> {
    if (!candidConfigured()) return [];
    // Intentionally unimplemented until Candid is purchased (shared 4.5/5.1
    // decision). Wiring point: call Candid's Premier/Essentials org search with
    // the query themes -> map results into NonprofitCandidate. Left as a seam so
    // turning Candid on is additive, not a rewrite.
    throw new Error(
      "candid: CANDID_API_KEY is set but the Candid adapter is not implemented yet — " +
        "wire the org-search call here when Candid is provisioned (shared 4.5/5.1 decision).",
    );
  },
};
