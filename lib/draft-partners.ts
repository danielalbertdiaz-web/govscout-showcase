// Item 4.1 — per-draft partner roster. Pure, load-bearing, fully unit-tested:
// no db, no fs, no model. The roster is the operator's curated answer to "who
// is on THIS draft, in what role, and is each one included in the assembled
// document?" — replacing the old singleton `meta.partnerLead`.
//
// It lives inside the draft's `meta_json` blob (key `partners`), so there is no
// schema migration. Legacy drafts are migrated *lazily at read time* by
// `readDraftRoster`, which never destroys the old fields.

export const PARTNER_ROLES = ["prime", "sub", "referral", "named"] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];

export function isPartnerRole(v: unknown): v is PartnerRole {
  return typeof v === "string" && (PARTNER_ROLES as readonly string[]).includes(v);
}

export const PARTNER_ROLE_LABELS: Record<PartnerRole, string> = {
  prime: "Prime",
  sub: "Subcontractor",
  referral: "Referral only",
  named: "Named partner",
};

// One row of the curated roster. `included` is the include/exclude toggle that
// gates whether this partner's content appears in the assembled draft.
export type DraftPartnerEntry = {
  partnerId: string;
  role: PartnerRole;
  included: boolean;
};

const DEFAULT_ROLE: PartnerRole = "sub";

// Drafts store meta as an open `Record<string, unknown>` blob; we read the few
// keys we care about defensively rather than constraining the whole shape.
type MetaShape = Record<string, unknown> | null | undefined;

// Coerce a single unknown value into a valid entry, or null if unusable.
function coerceEntry(value: unknown): DraftPartnerEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const partnerId = typeof v.partnerId === "string" ? v.partnerId.trim() : "";
  if (!partnerId) return null;
  return {
    partnerId,
    role: isPartnerRole(v.role) ? v.role : DEFAULT_ROLE,
    // default to included unless explicitly false — a partner placed on the
    // roster is "on the team" until the operator excludes them.
    included: v.included === false ? false : true,
  };
}

// De-dupe by partnerId, keeping the first occurrence (stable order).
function dedupe(entries: DraftPartnerEntry[]): DraftPartnerEntry[] {
  const seen = new Set<string>();
  const out: DraftPartnerEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.partnerId)) continue;
    seen.add(e.partnerId);
    out.push(e);
  }
  return out;
}

// Read the curated roster from a draft's meta, migrating legacy shapes in
// priority order:
//   1) meta.partners[]           — the curated roster (preferred)
//   2) meta.partnerLead          — singleton decision artifact → one `prime`
//   3) meta.partnerSelection.ids — auto-match snapshot → all `sub`
// Returns [] when none apply. Pure & total: never throws on bad input.
export function readDraftRoster(meta: MetaShape): DraftPartnerEntry[] {
  const m = (meta ?? {}) as MetaShape & Record<string, unknown>;

  if (Array.isArray(m.partners)) {
    return dedupe(m.partners.map(coerceEntry).filter((e): e is DraftPartnerEntry => e !== null));
  }

  // Legacy: a single paired lead becomes the prime, included.
  const lead = m.partnerLead;
  if (lead && typeof lead === "object" && typeof (lead as { partnerId?: unknown }).partnerId === "string") {
    const partnerId = (lead as { partnerId: string }).partnerId.trim();
    if (partnerId) return [{ partnerId, role: "prime", included: true }];
  }

  // Legacy: the auto-match snapshot becomes a roster of included subs.
  const sel = m.partnerSelection;
  const ids = sel && typeof sel === "object" ? (sel as { ids?: unknown }).ids : undefined;
  if (Array.isArray(ids)) {
    return dedupe(
      ids
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => ({ partnerId: id.trim(), role: DEFAULT_ROLE, included: true })),
    );
  }

  return [];
}

// --- Pure roster transforms (each returns a NEW array) ----------------------

// Add a partner if absent, or update its role/included if present.
export function upsertRosterEntry(
  roster: DraftPartnerEntry[],
  entry: { partnerId: string; role?: PartnerRole; included?: boolean },
): DraftPartnerEntry[] {
  const partnerId = entry.partnerId.trim();
  if (!partnerId) return roster;
  const existing = roster.find((e) => e.partnerId === partnerId);
  if (!existing) {
    return [
      ...roster,
      {
        partnerId,
        role: entry.role ?? DEFAULT_ROLE,
        included: entry.included ?? true,
      },
    ];
  }
  return roster.map((e) =>
    e.partnerId === partnerId
      ? { ...e, role: entry.role ?? e.role, included: entry.included ?? e.included }
      : e,
  );
}

export function removeFromRoster(roster: DraftPartnerEntry[], partnerId: string): DraftPartnerEntry[] {
  return roster.filter((e) => e.partnerId !== partnerId);
}

export function setIncluded(
  roster: DraftPartnerEntry[],
  partnerId: string,
  included: boolean,
): DraftPartnerEntry[] {
  return roster.map((e) => (e.partnerId === partnerId ? { ...e, included } : e));
}

export function setRole(
  roster: DraftPartnerEntry[],
  partnerId: string,
  role: PartnerRole,
): DraftPartnerEntry[] {
  return roster.map((e) => (e.partnerId === partnerId ? { ...e, role } : e));
}

// The partner ids that should actually flow into the assembled document /
// synthesis prompt: roster minus the excluded ones.
export function includedPartnerIds(roster: DraftPartnerEntry[]): string[] {
  return roster.filter((e) => e.included).map((e) => e.partnerId);
}

// Validate/normalize a roster posted by an API client. Drops malformed rows.
export function normalizeRosterInput(value: unknown): DraftPartnerEntry[] {
  if (!Array.isArray(value)) return [];
  return dedupe(value.map(coerceEntry).filter((e): e is DraftPartnerEntry => e !== null));
}

// Return a NEW meta object with the roster written under `partners`. Preserves
// every other key (including legacy partnerLead/partnerSelection for back-compat
// and audit). Pure — does not mutate the input.
export function writeRosterToMeta(
  meta: Record<string, unknown> | null | undefined,
  roster: DraftPartnerEntry[],
): Record<string, unknown> {
  return { ...(meta ?? {}), partners: roster };
}
