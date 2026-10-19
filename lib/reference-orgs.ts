// Item 4.4 — reference dataset pure core (Google.org winners + non-profit list).
//
// Pure + fully testable: no fs/db/model. The thin fs loader at the bottom reads
// the version-controlled seed at data/reference/index.json (env override
// REFERENCE_DATA_DIR). The scanner (4.5) reuses `referenceDedupeKey`,
// `matchesTheme`, and the winner signal so reference data improves candidate
// quality. Each record carries a source URL for auditability.

export type ReferenceKind = "google_org_winner" | "nonprofit" | "private_foundation";

export type ReferenceOrg = {
  id: string;
  kind: ReferenceKind;
  name: string;
  focusAreas: string[];
  geography: string | null;
  sourceUrl: string | null;
  note: string | null;
  /** Grant amount (winners) or total assets (private foundations) in USD; null if unknown. */
  amountUsd: number | null;
  /** Year of the grant/announcement — winners only; null when unknown. */
  year: number | null;
  /** IRS EIN — private foundations only (for 990-PF lookup); null otherwise. */
  ein: string | null;
};

export type ReferenceDataset = {
  orgs: ReferenceOrg[];
  metadata: Record<string, unknown>;
};

// --- normalization (total, never throws) -----------------------------------

function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t || null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(
    new Set(v.map((x) => asString(x)).filter((x): x is string => Boolean(x))),
  );
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function slugId(seed: string, fallback: string): string {
  const s = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

export function normalizeReferenceOrg(
  raw: unknown,
  kind: ReferenceKind,
  idHint = "org",
): ReferenceOrg | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = asString(r.name);
  if (!name) return null; // a reference record with no name is unusable
  const id = asString(r.id) ?? slugId(name, idHint);
  return {
    id,
    kind,
    name,
    focusAreas: asStringArray(r.focus_areas ?? r.focusAreas),
    geography: asString(r.geography),
    sourceUrl: asString(r.source_url ?? r.sourceUrl),
    note: asString(r.note),
    amountUsd: asNumber(r.amount_usd ?? r.amountUsd),
    year: asNumber(r.year),
    ein: asString(r.ein),
  };
}

export function normalizeReferenceDataset(raw: unknown): ReferenceDataset {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const winners = Array.isArray(r.google_org_winners) ? r.google_org_winners : [];
  const nonprofits = Array.isArray(r.nonprofits) ? r.nonprofits : [];
  const foundations = Array.isArray(r.private_foundations) ? r.private_foundations : [];
  const orgs: ReferenceOrg[] = [];
  for (const w of winners) {
    const o = normalizeReferenceOrg(w, "google_org_winner", "gow");
    if (o) orgs.push(o);
  }
  for (const n of nonprofits) {
    const o = normalizeReferenceOrg(n, "nonprofit", "np");
    if (o) orgs.push(o);
  }
  for (const f of foundations) {
    const o = normalizeReferenceOrg(f, "private_foundation", "pf");
    if (o) orgs.push(o);
  }
  const metadata =
    r.metadata && typeof r.metadata === "object"
      ? (r.metadata as Record<string, unknown>)
      : {};
  return { orgs, metadata };
}

// --- query / filter ---------------------------------------------------------

export type ReferenceFilter = {
  q?: string | null;
  kind?: ReferenceKind | "all" | null;
  focusArea?: string | null;
  geography?: string | null;
};

export function filterReferenceOrgs(
  orgs: ReferenceOrg[],
  f: ReferenceFilter = {},
): ReferenceOrg[] {
  const ql = f.q?.trim().toLowerCase() ?? "";
  const focus = f.focusArea?.trim().toLowerCase() ?? "";
  const geo = f.geography?.trim().toLowerCase() ?? "";
  const kind = f.kind && f.kind !== "all" ? f.kind : null;
  return orgs.filter((o) => {
    if (kind && o.kind !== kind) return false;
    if (focus && !o.focusAreas.some((a) => a.toLowerCase() === focus)) return false;
    if (geo && !(o.geography ?? "").toLowerCase().includes(geo)) return false;
    if (!ql) return true;
    const blob = [o.name, o.geography, o.note, o.focusAreas.join(" ")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return blob.includes(ql);
  });
}

/** Every distinct focus area present, sorted — drives filter dropdowns. */
export function focusAreasOf(orgs: ReferenceOrg[]): string[] {
  const s = new Set<string>();
  for (const o of orgs) for (const a of o.focusAreas) s.add(a);
  return Array.from(s).sort();
}

// B6 — cold-outreach fit: which reference orgs are worth approaching with
// "you run the program, Acme delivers as your sub". Pure: focus-area overlap
// against the enabled scout-profile vocabulary.
//   - A WINNER (funded non-profit) doing Acme-aligned work is a STRONG target:
//     they hold money and need delivery capacity — exactly the sub play.
//   - A FOUNDATION with aligned themes is a FUNDER match: not a sub host, but
//     a source whose grantees are.
import { SCOUT_PROFILES } from "./scout-profiles";

const EL_SERVICE_VOCAB = Array.from(
  new Set(
    SCOUT_PROFILES.filter((p) => p.enabled)
      .flatMap((p) => p.keywords)
      .map((k) => k.toLowerCase()),
  ),
);

export type OutreachFit = { tier: "strong" | "funder"; matchedAreas: string[] } | null;

export function referenceOutreachFit(org: ReferenceOrg): OutreachFit {
  const matched = org.focusAreas.filter((area) => {
    const a = area.toLowerCase().replace(/_/g, " ");
    return EL_SERVICE_VOCAB.some((kw) => a.includes(kw) || kw.includes(a));
  });
  if (matched.length === 0) return null;
  // Winners + non-profits HOLD or win program money → can host Acme as a sub.
  // Private foundations FUND — a different (funder-research) conversation.
  const tier = org.kind === "private_foundation" ? "funder" : "strong";
  return { tier, matchedAreas: matched };
}

// --- shared with the scanner (4.5) -----------------------------------------

/**
 * Stable, case-insensitive identity for an org by NAME, so the scanner (4.5)
 * can de-dupe discovered candidates against reference winners / non-profits and
 * against the partner roster + leads. Strips a few common legal suffixes and
 * punctuation so "The Fortune Society, Inc." == "Fortune Society".
 */
export function referenceDedupeKey(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(the|inc|incorporated|llc|corp|corporation|foundation|fund)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return `org:${cleaned}`;
}

/**
 * True when an org's focus areas overlap any of the given theme keywords
 * (case-insensitive, substring-tolerant). Used by 4.5 to bias candidate quality
 * toward orgs aligned with the opportunity's funding theme.
 */
export function matchesTheme(org: ReferenceOrg, themeKeywords: string[]): boolean {
  if (themeKeywords.length === 0) return false;
  const themes = themeKeywords.map((t) => t.toLowerCase()).filter(Boolean);
  return org.focusAreas.some((area) => {
    const a = area.toLowerCase();
    return themes.some((t) => a.includes(t) || t.includes(a));
  });
}
