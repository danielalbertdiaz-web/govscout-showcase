// Controlled vocabulary + normaliser for set-aside values (improvement #2).
//
// Live fp_opportunities spelled "total small business" four ways and "no
// set-aside" three ways; any eligibility rule over the raw column was wrong
// roughly one time in three (routing matrix R-2), and six of the 82 Bid Board
// merge conflicts were on this field. This module is the single vocabulary;
// migration 039 backfills it and both upserts apply it at ingest.
//
// THE CARDINAL RULE: unrecognised or ABSENT input maps to "unknown", never to
// "none". "I could not classify this" and "this is open to everyone" are
// opposite claims — defaulting to none would silently widen eligibility.
// That includes NULL: all 295 micro_contracts rows have NULL set_aside
// because the sweep importer never captures the field — that is uncaptured
// data, not a declaration that no set-aside exists.
//
// Pure — no db, no clock. The raw string is ALWAYS preserved alongside the
// canonical value; provenance is never discarded.

export const SET_ASIDE_CANONICAL = [
  "none",
  "small_business",
  "sdvosb",
  "wosb",
  "edwosb",
  "hubzone",
  "8a",
  "isbee",
  "bicIv",
  "unknown",
] as const;

export type SetAsideCanonical = (typeof SET_ASIDE_CANONICAL)[number];

export function isSetAsideCanonical(s: unknown): s is SetAsideCanonical {
  return typeof s === "string" && (SET_ASIDE_CANONICAL as readonly string[]).includes(s);
}

/**
 * Normalise a raw set-aside string to the controlled vocabulary. The raw
 * input is returned untouched alongside the canonical value.
 *
 * Matching is deliberately conservative: only phrasings actually seen (or
 * unambiguous standard SAM forms) map to a specific value; everything else —
 * including "TBD", "Sources Sought", and "RFI" phrasings that only speculate
 * about a future set-aside — lands on "unknown".
 */
export function normaliseSetAside(raw: string | null | undefined): {
  canonical: SetAsideCanonical;
  raw: string | null;
} {
  const original = raw ?? null;
  if (!raw || !raw.trim()) return { canonical: "unknown", raw: original };
  const s = raw.trim().toLowerCase();

  // Speculative / undetermined phrasings first — a notice that SAYS the
  // set-aside is undecided must not match a specific family below.
  if (
    s.startsWith("tbd") ||
    s.includes("sources sought") ||
    s.startsWith("rfi") ||
    s.includes("may be") ||
    s.includes("may set aside")
  ) {
    return { canonical: "unknown", raw: original };
  }

  // Explicit "no set-aside" declarations.
  if (
    s === "none" ||
    s.startsWith("none ") ||
    s.startsWith("none(") ||
    s.startsWith("none (") ||
    s === "n/a" ||
    s === "no set-aside" ||
    s === "no set aside" ||
    s === "full and open" ||
    s === "full & open" ||
    s === "unrestricted"
  ) {
    return { canonical: "none", raw: original };
  }

  // Specific programs before the generic small-business family, so
  // "SDVOSB small business set-aside" lands on the specific program.
  if (s.includes("sdvosb") || s.includes("service-disabled") || s.includes("service disabled")) {
    return { canonical: "sdvosb", raw: original };
  }
  if (s.includes("edwosb") || s.includes("economically disadvantaged women")) {
    return { canonical: "edwosb", raw: original };
  }
  if (s.includes("wosb") || s.includes("women-owned") || s.includes("women owned")) {
    return { canonical: "wosb", raw: original };
  }
  if (s.includes("hubzone") || s.includes("hub zone")) {
    return { canonical: "hubzone", raw: original };
  }
  if (s.includes("8(a)") || s === "8a" || s.startsWith("8a ")) {
    return { canonical: "8a", raw: original };
  }
  if (s.includes("isbee") || s.includes("indian small business economic enterprise")) {
    return { canonical: "isbee", raw: original };
  }
  // Buy Indian Act — "BICiv Buy Indian Set-Aside" is the phrasing the sweep's
  // own kill reasons use (confirmed 2026-08-04; this is what the reserved
  // vocabulary slot was for).
  if (s.includes("buy indian") || s.includes("biciv")) {
    return { canonical: "bicIv", raw: original };
  }

  // The generic small-business family — the concept live data spelled four
  // ways: "Total Small Business Set-Aside", "Total Small Business", "SBA",
  // "SBA Total Small Business".
  if (s === "sba" || s.includes("total small business") || s.includes("small business set-aside") || s.includes("small business set aside")) {
    return { canonical: "small_business", raw: original };
  }

  return { canonical: "unknown", raw: original };
}
