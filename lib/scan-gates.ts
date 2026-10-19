// Deterministic scanner scoring gates (SCANNER_SCORING_DEFECT_PACKET, 2026-08-04).
//
// Three real solicitations (ACWS26-CFS-001 100/100, 693JJ926R000007 72→80/100,
// FD2399-26-00126 75/100) were scored as confident AI-deliverability leads from
// the SAM.gov notice text alone, with nothing gating the score on eligibility
// or scale. The string-detectable parts of that gate belong in code, not in a
// cron prompt — an LLM noticing a FAR citation every run forever is a hope,
// not a guarantee. Pure regex/string logic only (no DB, no Node APIs), so this
// is importable from the scanner, the pipeline store, and client bundles alike.
//
// The governing principle, from the same day's foreign-place-of-performance
// over-kill (five US State Dept solicitations auto-killed, two of them
// actually bid): A WRONG AUTO-KILL COSTS FAR MORE THAN A LEAD THAT NEEDED A
// HUMAN GLANCE. Hence the tier split:
//
//   Tier 1 (admitEligibility)   — hard exclude, but ONLY on a positive match
//                                 against a known citation/clause pattern.
//                                 Uncertain → admitted, marked unclassified.
//                                 Same defensive posture as admitSetAside.
//   Tier 2 (detectScaleSignals) — downgrade-only. A signal caps the score and
//                                 attaches a visible named reason; it can
//                                 NEVER remove a notice from view. A large
//                                 program can contain a small Acme-shaped
//                                 carve-out.
//   Tier 3                      — genuine scope-fit judgement; stays in the
//                                 scanner prompts, deliberately not here.

// --- Tier 1: string-detectable eligibility facts -----------------------------

export type EligibilityExclusionReason =
  | "sole_source_brand_name" // FAR 16.505(a)(4) brand-name/sole-source citation
  | "authorized_reseller_only"; // explicit authorized-reseller/distributor-only clause

export type EligibilityAdmission =
  /**
   * Admitted means "no known disqualifying pattern matched" — it is NOT a
   * finding of eligibility, which code cannot make. Hence the only admitted
   * reason is "unclassified" (mirror of admitSetAside's unknown side).
   */
  | { admitted: true; reason: "unclassified" }
  | { admitted: false; reason: EligibilityExclusionReason; evidence: string };

// The specific brand-name/sole-source exception citation (FD2399-26-00126
// carried it verbatim in the notice text and still scored 75/100). Spacing
// varies across notices; bare "16.505" or other paragraphs never match.
const FAR_BRAND_NAME_CITATION = /\b16\.505\s*\(\s*a\s*\)\s*\(\s*4\s*\)(?:\s*\(\s*i\s*\))?/i;

// "Only an authorized [product] reseller may respond" and phrasing variants.
// Product names sit between "authorized" and "reseller" ("only an authorized
// Ansys/AGI STK reseller can quote"), so allow a few intervening tokens.
const RESELLER_ONLY_CLAUSES = [
  /\bonly\s+(?:an?\s+)?authori[sz]ed\s+(?:\S+\s+){0,6}?(?:re)?sellers?\b/i,
  /\bonly\s+(?:an?\s+)?authori[sz]ed\s+(?:\S+\s+){0,6}?distributors?\b/i,
  /\bauthori[sz]ed\s+(?:re)?sellers?\s+only\b/i,
  /\bauthori[sz]ed\s+distributors?\s+only\b/i,
  /\bmust\s+be\s+(?:an?\s+)?authori[sz]ed\s+(?:\S+\s+){0,6}?(?:re)?sellers?\b/i,
];

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? t.slice(0, 200) : t;
}

/**
 * Tier 1 gate. Exclude ONLY on a positive match against a known pattern; when
 * uncertain, admit and mark unclassified. Absence of evidence is never treated
 * as disqualification — loose language ("sole source", bare "16.505") does NOT
 * match, by design: inferring ineligibility from vibes is how the foreign-PoP
 * rule killed five biddable State Dept solicitations.
 */
export function admitEligibility(text: string | null): EligibilityAdmission {
  const hay = text ?? "";
  const far = FAR_BRAND_NAME_CITATION.exec(hay);
  if (far) {
    return { admitted: false, reason: "sole_source_brand_name", evidence: clip(far[0]) };
  }
  for (const re of RESELLER_ONLY_CLAUSES) {
    const m = re.exec(hay);
    if (m) return { admitted: false, reason: "authorized_reseller_only", evidence: clip(m[0]) };
  }
  return { admitted: true, reason: "unclassified" };
}

// --- Tier 2: enterprise-scale signals (downgrade-only, NEVER a kill) ---------

export const SCALE_SIGNAL_KINDS = [
  "impact_level", // IL-4/5/6 secure cloud (ACWS: IL-6)
  "ato", // Authority to Operate
  "cso", // Commercial Solutions Opening
  "vce", // Virtual Contracting Enterprise integration
  "staffed_labor_hours", // named labor categories with real hour counts (NHTSA: 4,173 hrs yr 1)
  "multi_year_tm", // multi-year T&M staffed-services structure (NHTSA: 60-month T&M)
  "credentialed_reviewer", // mandatory third-party credentialed reviewer
  "human_subjects", // IRB-managed human-subjects work
] as const;
export type ScaleSignalKind = (typeof SCALE_SIGNAL_KINDS)[number];

export function isScaleSignalKind(s: unknown): s is ScaleSignalKind {
  return typeof s === "string" && (SCALE_SIGNAL_KINDS as readonly string[]).includes(s);
}

export type ScaleSignal = {
  kind: ScaleSignalKind;
  /** The matched text (or the scanner's own citation, for agent-reported signals). */
  evidence: string;
};

// Case-sensitive entries catch the all-caps acronym; the /i entries catch the
// spelled-out phrase. False positives here are tolerable by design — the cost
// is a capped score plus a human glance, never a lost lead.
const SIGNAL_PATTERNS: ReadonlyArray<{ kind: ScaleSignalKind; res: RegExp[] }> = [
  { kind: "impact_level", res: [/\bIL[-\s]?[456]\b/, /\bimpact level\s*[456]\b/i] },
  { kind: "ato", res: [/\bATO\b/, /\bauthori[sz](?:ation|ty) to operate\b/i] },
  { kind: "cso", res: [/\bCSO\b/, /\bcommercial solutions opening\b/i] },
  { kind: "vce", res: [/\bVCE\b/, /\bvirtual contracting enterprise\b/i] },
  {
    kind: "staffed_labor_hours",
    // 1,000+ hours (comma-grouped or 4+ digits) or explicit FTE counts.
    res: [/\b\d{1,3}(?:,\d{3})+\s*(?:labor[-\s])?hours\b/i, /\b\d{4,}\s*(?:labor[-\s])?hours\b/i, /\b\d+(?:\.\d+)?\s*FTEs?\b/],
  },
  { kind: "credentialed_reviewer", res: [/\bindependent\s+(?:qa\s+|quality\s+assurance\s+)?reviewer\b/i, /\bthird[-\s]party\s+(?:credential|certifi)\w*/i] },
  { kind: "human_subjects", res: [/\bIRB\b/, /\binstitutional review board\b/i, /\bhuman[-\s]subjects?\b/i] },
];

// multi_year_tm is compound: a T&M marker AND a multi-year marker must both be
// present — "T&M" alone is a pricing detail, "60-month" alone is a PoP detail;
// together they are the NHTSA staffed-services shape.
const TM_MARKERS = [/\bT&M\b/i, /\btime[-\s]and[-\s]materials?\b/i];
const MULTI_YEAR_MARKERS = [
  /\b(?:2[4-9]|[3-9]\d|[1-9]\d{2})[-\s]month\b/i, // 24+ months
  /\bmulti[-\s]?year\b/i,
  /\b(?:three|four|five|ten)[-\s]year\b/i,
];

function firstMatch(hay: string, res: RegExp[]): string | null {
  for (const re of res) {
    const m = re.exec(hay);
    if (m) return m[0];
  }
  return null;
}

/**
 * Tier 2 detector. Returns every enterprise-scale signal present in the text,
 * in vocabulary order, each with the text that matched. Detection carries NO
 * verdict: callers may cap/discount a score and attach the reasons, and must
 * keep the notice in the candidate list.
 */
export function detectScaleSignals(text: string | null): ScaleSignal[] {
  const hay = text ?? "";
  if (!hay.trim()) return [];
  const out: ScaleSignal[] = [];
  for (const { kind, res } of SIGNAL_PATTERNS) {
    const m = firstMatch(hay, res);
    if (m) out.push({ kind, evidence: clip(m) });
  }
  const tm = firstMatch(hay, TM_MARKERS);
  const years = tm ? firstMatch(hay, MULTI_YEAR_MARKERS) : null;
  if (tm && years) out.push({ kind: "multi_year_tm", evidence: clip(`${years} / ${tm}`) });
  return out.sort(
    (a, b) => SCALE_SIGNAL_KINDS.indexOf(a.kind) - SCALE_SIGNAL_KINDS.indexOf(b.kind),
  );
}

/**
 * Validate scanner-supplied signals (agents report attachment-derived evidence
 * — e.g. an hours table that exists only in the 81-page RFP, not the notice).
 * Unknown kinds are dropped, evidence is clipped, duplicates collapse to the
 * first occurrence. Accepts bare kind strings as well as {kind, evidence}.
 */
export function sanitiseScaleSignals(value: unknown): ScaleSignal[] {
  if (!Array.isArray(value)) return [];
  const seen = new Map<ScaleSignalKind, ScaleSignal>();
  for (const v of value) {
    if (isScaleSignalKind(v)) {
      if (!seen.has(v)) seen.set(v, { kind: v, evidence: "" });
      continue;
    }
    if (v && typeof v === "object") {
      const kind = (v as { kind?: unknown }).kind;
      if (!isScaleSignalKind(kind) || seen.has(kind)) continue;
      const ev = (v as { evidence?: unknown }).evidence;
      seen.set(kind, { kind, evidence: typeof ev === "string" ? clip(ev) : "" });
    }
  }
  return [...seen.values()].sort(
    (a, b) => SCALE_SIGNAL_KINDS.indexOf(a.kind) - SCALE_SIGNAL_KINDS.indexOf(b.kind),
  );
}

/** Union of signal lists, deduped by kind (first evidence wins), vocab order. */
export function mergeScaleSignals(...lists: ScaleSignal[][]): ScaleSignal[] {
  const seen = new Map<ScaleSignalKind, ScaleSignal>();
  for (const list of lists) {
    for (const s of list) if (!seen.has(s.kind)) seen.set(s.kind, s);
  }
  return [...seen.values()].sort(
    (a, b) => SCALE_SIGNAL_KINDS.indexOf(a.kind) - SCALE_SIGNAL_KINDS.indexOf(b.kind),
  );
}

/**
 * Ceiling for ai_deliverability_score on a row carrying any scale signal —
 * one below the scanners' "pull the actual RFP before scoring above 70" line,
 * so a scale-flagged notice can never present in the confidence band that
 * requires having read the attachment. The signal names travel with the row;
 * the notice itself always stays visible.
 */
export const SCALE_SIGNAL_SCORE_CAP = 69;

// --- The attachment gate -----------------------------------------------------

/**
 * What the AI-deliverability score was computed FROM — the machine-readable
 * counterpart of the prose caveat, same pattern as price_basis ("amount
 * unverified — no total line found"). "notice_only" is the DEFAULT: a score is
 * marked attachment_reviewed only by exact positive assertion; anything else —
 * absent, null, misspelled, free text — reads as unverified. Unverifiable must
 * never read as verified.
 */
export const FP_SCORE_BASES = ["notice_only", "attachment_reviewed"] as const;
export type FpScoreBasis = (typeof FP_SCORE_BASES)[number];

export function isFpScoreBasis(s: unknown): s is FpScoreBasis {
  return typeof s === "string" && (FP_SCORE_BASES as readonly string[]).includes(s);
}

/** Resolve a caller-supplied basis claim to the stored vocabulary. */
export function resolveScoreBasis(claim: unknown): FpScoreBasis {
  return claim === "attachment_reviewed" ? "attachment_reviewed" : "notice_only";
}
