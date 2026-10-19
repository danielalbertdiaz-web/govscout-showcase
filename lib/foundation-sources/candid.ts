// Item 5.1 — Candid (Foundation Directory Online) adapter SEAM.
//
// HYBRID decision (locked, shared with 4.5): the free PND-RSS + foundation-pages
// path is the live default; Candid is a clean, interface-compatible seam that
// lights up WITHOUT touching the scanner when a key is provisioned. "Don't pay
// twice" — if Candid is bought for 4.5 org profiles, this also covers
// foundation grant search.
//
// Until CANDID_API_KEY is configured, `available` is false and `fetch` returns
// []. The registry skips unavailable sources, so this is a no-op today.

import type { FoundationGrant, FoundationQuery, FoundationSource } from "./types";

function candidConfigured(): boolean {
  return Boolean(process.env.CANDID_API_KEY?.trim());
}

export const candidFoundationSource: FoundationSource = {
  id: "candid",
  get available() {
    return candidConfigured();
  },
  async fetch(_query: FoundationQuery): Promise<FoundationGrant[]> {
    if (!candidConfigured()) return [];
    // Intentionally unimplemented until Candid is purchased (shared 4.5/5.1
    // decision). Wiring point: call Candid's grants/RFP search with the query
    // themes/keywords -> map results into FoundationGrant. Left as a seam so
    // turning Candid on is additive, not a rewrite.
    throw new Error(
      "candid (foundations): CANDID_API_KEY is set but the Candid adapter is not implemented yet — " +
        "wire the grants-search call here when Candid is provisioned (shared 4.5/5.1 decision).",
    );
  },
};
