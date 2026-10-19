// Track L (Earmarked Awareness Radar) — DB layer. Spec: GOVSCOUT-TRACK-L.md.
// Every function is tenant-filtered (single hardcoded tenant in the v5
// fallback build). Upserts hit the §1 natural keys so ingestion jobs are
// idempotent; funding-event and signal writes recompute the agency score
// (§3) inline, so score/tier/reason_codes are never stale.

import { getDb } from "./db";
import {
  TRACK_L_TENANT,
  isAgencyType,
  isTier,
  isFundingProgram,
  type AgencyType,
  type Tier,
  type ContactPriority,
  type ContactSource,
  type FundingProgram,
  type SignalType,
  type OutreachStage,
  type HealthAgency,
  type TrackLContact,
  type FundingEvent,
  type TrackLSignal,
  type UnmatchedAward,
  type AgencyListRow,
  type AgencyDetail,
} from "./track-l-types";

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// --- row mappers ------------------------------------------------------------

type AgencyRow = {
  id: string;
  tenant_id: string;
  name: string;
  type: string;
  state: string;
  county: string | null;
  fips_code: string | null;
  website: string | null;
  procurement_threshold: number | null;
  quote_requirement: string | null;
  fiscal_year_end: string | null;
  housing_pre1978_pct: number | null;
  blood_lead_elevated: number | null;
  score: number;
  reason_codes: string;
  tier: string;
  snapshot_url: string | null;
  created_at: number;
  updated_at: number;
};

function rowToAgency(row: AgencyRow): HealthAgency {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    type: isAgencyType(row.type) ? row.type : "OTHER",
    state: row.state,
    county: row.county,
    fipsCode: row.fips_code,
    website: row.website,
    procurementThreshold: row.procurement_threshold,
    quoteRequirement: row.quote_requirement,
    fiscalYearEnd: row.fiscal_year_end,
    housingPre1978Pct: row.housing_pre1978_pct,
    bloodLeadElevated: row.blood_lead_elevated == null ? null : row.blood_lead_elevated === 1,
    score: Number(row.score ?? 0),
    reasonCodes: safeParse<string[]>(row.reason_codes, []),
    tier: isTier(row.tier) ? row.tier : "STANDARD",
    snapshotUrl: row.snapshot_url,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

type ContactRow = {
  id: string;
  tenant_id: string;
  agency_id: string;
  name: string | null;
  title: string | null;
  email: string;
  email_verified: number;
  is_generic: number;
  priority: string;
  source: string;
  source_url: string | null;
};

function rowToContact(row: ContactRow): TrackLContact {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agencyId: row.agency_id,
    name: row.name,
    title: row.title,
    email: row.email,
    emailVerified: row.email_verified === 1,
    isGeneric: row.is_generic === 1,
    priority: row.priority as ContactPriority,
    source: row.source as ContactSource,
    sourceUrl: row.source_url,
  };
}

type EventRow = {
  id: string;
  tenant_id: string;
  agency_id: string;
  program: string;
  amount: number | null;
  award_date: string | null;
  spend_deadline: string | null;
  source_url: string;
  raw_archive_key: string | null;
};

function rowToEvent(row: EventRow): FundingEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agencyId: row.agency_id,
    program: isFundingProgram(row.program) ? row.program : "OTHER",
    amount: row.amount == null ? null : Number(row.amount),
    awardDate: row.award_date,
    spendDeadline: row.spend_deadline,
    sourceUrl: row.source_url,
    rawArchiveKey: row.raw_archive_key,
  };
}

type SignalRow = {
  id: string;
  tenant_id: string;
  agency_id: string;
  type: string;
  weight: number;
  observed_at: number;
  source_url: string | null;
  note: string | null;
};

function rowToSignal(row: SignalRow): TrackLSignal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agencyId: row.agency_id,
    type: row.type as SignalType,
    weight: Number(row.weight),
    observedAt: Number(row.observed_at),
    sourceUrl: row.source_url,
    note: row.note,
  };
}

// --- agencies ---------------------------------------------------------------

export type UpsertAgencyInput = {
  name: string;
  state: string; // 2-letter
  type?: AgencyType;
  county?: string | null;
  fipsCode?: string | null;
  website?: string | null;
  procurementThreshold?: number | null;
  quoteRequirement?: string | null;
  fiscalYearEnd?: string | null;
  housingPre1978Pct?: number | null;
  bloodLeadElevated?: boolean | null;
};

/**
 * Upsert on the §1 natural key (tenant, name, state). Preserve-on-upsert:
 * only fields present in the input overwrite stored values, so a re-scan
 * never clobbers data another source contributed (same discipline as
 * upsertDiscoveredPool / upsertFpOpportunity).
 */
export function upsertAgency(input: UpsertAgencyInput): { agency: HealthAgency; created: boolean } {
  const name = input.name.trim();
  const state = input.state.trim().toUpperCase();
  if (!name) throw new Error("agency name is required");
  if (!/^[A-Z]{2}$/.test(state)) throw new Error(`invalid state: ${input.state}`);

  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM trackl_agencies WHERE tenant_id = ? AND name = ? AND state = ?")
    .get(TRACK_L_TENANT, name, state) as AgencyRow | undefined;
  const now = Date.now();

  if (!existing) {
    const id = randomId();
    db.prepare(`
      INSERT INTO trackl_agencies (
        id, tenant_id, name, type, state, county, fips_code, website,
        procurement_threshold, quote_requirement, fiscal_year_end,
        housing_pre1978_pct, blood_lead_elevated, score, reason_codes, tier,
        snapshot_url, created_at, updated_at
      ) VALUES (
        @id, @tenant_id, @name, @type, @state, @county, @fips_code, @website,
        @procurement_threshold, @quote_requirement, @fiscal_year_end,
        @housing_pre1978_pct, @blood_lead_elevated, 0, '[]', 'LOW',
        NULL, @created_at, @updated_at
      )
    `).run({
      id,
      tenant_id: TRACK_L_TENANT,
      name,
      type: input.type ?? "OTHER",
      state,
      county: input.county ?? null,
      fips_code: input.fipsCode ?? null,
      website: input.website ?? null,
      procurement_threshold: input.procurementThreshold ?? null,
      quote_requirement: input.quoteRequirement ?? null,
      fiscal_year_end: input.fiscalYearEnd ?? null,
      housing_pre1978_pct: input.housingPre1978Pct ?? null,
      blood_lead_elevated: input.bloodLeadElevated == null ? null : input.bloodLeadElevated ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
    recomputeAgencyScore(id);
    const row = db.prepare("SELECT * FROM trackl_agencies WHERE id = ?").get(id) as AgencyRow;
    return { agency: rowToAgency(row), created: true };
  }

  const fields: string[] = [];
  const params: Record<string, unknown> = { id: existing.id };
  const set = (col: string, v: unknown) => {
    fields.push(`${col} = @${col}`);
    params[col] = v;
  };
  if (input.type !== undefined) set("type", input.type);
  if (input.county !== undefined) set("county", input.county);
  if (input.fipsCode !== undefined) set("fips_code", input.fipsCode);
  if (input.website !== undefined) set("website", input.website);
  if (input.procurementThreshold !== undefined) set("procurement_threshold", input.procurementThreshold);
  if (input.quoteRequirement !== undefined) set("quote_requirement", input.quoteRequirement);
  if (input.fiscalYearEnd !== undefined) set("fiscal_year_end", input.fiscalYearEnd);
  if (input.housingPre1978Pct !== undefined) set("housing_pre1978_pct", input.housingPre1978Pct);
  if (input.bloodLeadElevated !== undefined) {
    set("blood_lead_elevated", input.bloodLeadElevated == null ? null : input.bloodLeadElevated ? 1 : 0);
  }
  if (fields.length > 0) {
    set("updated_at", now);
    db.prepare(`UPDATE trackl_agencies SET ${fields.join(", ")} WHERE id = @id`).run(params);
    // housing pct / blood-lead flag feed §3 inputs — keep score in step.
    if (input.housingPre1978Pct !== undefined || input.bloodLeadElevated !== undefined) {
      recomputeAgencyScore(existing.id);
    }
  }
  const row = db.prepare("SELECT * FROM trackl_agencies WHERE id = ?").get(existing.id) as AgencyRow;
  return { agency: rowToAgency(row), created: false };
}

export function getAgencyById(id: string): HealthAgency | null {
  const row = getDb()
    .prepare("SELECT * FROM trackl_agencies WHERE id = ? AND tenant_id = ?")
    .get(id, TRACK_L_TENANT) as AgencyRow | undefined;
  return row ? rowToAgency(row) : null;
}

/**
 * Fuzzy-resolve a grantee name (e.g. from a HUD award row) to an agency.
 * Conservative on purpose: exact-normalized match, then containment either
 * way, always state-scoped when a state is known. Misses land in the
 * UnmatchedAward review queue — never guessed into the wrong agency.
 */
export function findAgencyByFuzzyName(granteeName: string, state?: string | null): HealthAgency | null {
  const db = getDb();
  const norm = normalizeAgencyName(granteeName);
  if (!norm) return null;
  const rows = (
    state
      ? db.prepare("SELECT * FROM trackl_agencies WHERE tenant_id = ? AND state = ?").all(TRACK_L_TENANT, state.toUpperCase())
      : db.prepare("SELECT * FROM trackl_agencies WHERE tenant_id = ?").all(TRACK_L_TENANT)
  ) as AgencyRow[];
  let contains: AgencyRow | null = null;
  for (const r of rows) {
    const rn = normalizeAgencyName(r.name);
    if (rn === norm) return rowToAgency(r);
    if (!contains && rn.length >= 8 && norm.length >= 8 && (rn.includes(norm) || norm.includes(rn))) {
      contains = r;
    }
  }
  return contains ? rowToAgency(contains) : null;
}

export function normalizeAgencyName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(county|city|of|the|department|dept|health|public|services|district|and|&|office|division|bureau)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// --- contacts ---------------------------------------------------------------

export type UpsertContactInput = {
  agencyId: string;
  email: string;
  name?: string | null;
  title?: string | null;
  isGeneric?: boolean;
  priority: ContactPriority;
  source: ContactSource;
  sourceUrl?: string | null;
};

export function upsertContact(input: UpsertContactInput): { contact: TrackLContact; created: boolean } {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`invalid email: ${input.email}`);
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM trackl_contacts WHERE tenant_id = ? AND agency_id = ? AND email = ?")
    .get(TRACK_L_TENANT, input.agencyId, email) as ContactRow | undefined;
  const now = Date.now();
  if (!existing) {
    const id = randomId();
    db.prepare(`
      INSERT INTO trackl_contacts (
        id, tenant_id, agency_id, name, title, email, email_verified,
        is_generic, priority, source, source_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      TRACK_L_TENANT,
      input.agencyId,
      input.name ?? null,
      input.title ?? null,
      email,
      input.isGeneric ? 1 : 0,
      input.priority,
      input.source,
      input.sourceUrl ?? null,
      now,
      now,
    );
    const row = db.prepare("SELECT * FROM trackl_contacts WHERE id = ?").get(id) as ContactRow;
    return { contact: rowToContact(row), created: true };
  }
  // Refresh name/title if the new source knows more (named beats null), keep
  // the strongest (lowest) priority.
  const better =
    input.priority < existing.priority ? input.priority : (existing.priority as ContactPriority);
  db.prepare(`
    UPDATE trackl_contacts
       SET name = COALESCE(?, name), title = COALESCE(?, title),
           priority = ?, updated_at = ?
     WHERE id = ?
  `).run(input.name ?? null, input.title ?? null, better, now, existing.id);
  const row = db.prepare("SELECT * FROM trackl_contacts WHERE id = ?").get(existing.id) as ContactRow;
  return { contact: rowToContact(row), created: false };
}

// --- funding events ---------------------------------------------------------

export type UpsertFundingEventInput = {
  agencyId: string;
  program: FundingProgram;
  amount?: number | null;
  awardDate?: string | null; // ISO date
  spendDeadline?: string | null;
  sourceUrl: string;
  rawArchiveKey?: string | null;
};

export function upsertFundingEvent(input: UpsertFundingEventInput): { event: FundingEvent; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM trackl_funding_events
        WHERE tenant_id = ? AND agency_id = ? AND program = ? AND COALESCE(award_date, '') = COALESCE(?, '')`,
    )
    .get(TRACK_L_TENANT, input.agencyId, input.program, input.awardDate ?? null) as EventRow | undefined;
  const now = Date.now();
  if (!existing) {
    const id = randomId();
    db.prepare(`
      INSERT INTO trackl_funding_events (
        id, tenant_id, agency_id, program, amount, award_date, spend_deadline,
        source_url, raw_archive_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      TRACK_L_TENANT,
      input.agencyId,
      input.program,
      input.amount ?? null,
      input.awardDate ?? null,
      input.spendDeadline ?? null,
      input.sourceUrl,
      input.rawArchiveKey ?? null,
      now,
      now,
    );
    recomputeAgencyScore(input.agencyId);
    const row = db.prepare("SELECT * FROM trackl_funding_events WHERE id = ?").get(id) as EventRow;
    return { event: rowToEvent(row), created: true };
  }
  db.prepare(`
    UPDATE trackl_funding_events
       SET amount = COALESCE(?, amount),
           spend_deadline = COALESCE(?, spend_deadline),
           source_url = ?, raw_archive_key = COALESCE(?, raw_archive_key),
           updated_at = ?
     WHERE id = ?
  `).run(
    input.amount ?? null,
    input.spendDeadline ?? null,
    input.sourceUrl,
    input.rawArchiveKey ?? null,
    now,
    existing.id,
  );
  recomputeAgencyScore(input.agencyId);
  const row = db.prepare("SELECT * FROM trackl_funding_events WHERE id = ?").get(existing.id) as EventRow;
  return { event: rowToEvent(row), created: false };
}

// --- signals ----------------------------------------------------------------

export type UpsertSignalInput = {
  agencyId: string;
  type: SignalType;
  weight: number;
  sourceUrl?: string | null;
  note?: string | null;
};

export function upsertSignal(input: UpsertSignalInput): { signal: TrackLSignal; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT * FROM trackl_signals
        WHERE tenant_id = ? AND agency_id = ? AND type = ? AND COALESCE(source_url, '') = COALESCE(?, '')`,
    )
    .get(TRACK_L_TENANT, input.agencyId, input.type, input.sourceUrl ?? null) as SignalRow | undefined;
  const now = Date.now();
  if (!existing) {
    const id = randomId();
    db.prepare(`
      INSERT INTO trackl_signals (id, tenant_id, agency_id, type, weight, observed_at, source_url, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, TRACK_L_TENANT, input.agencyId, input.type, input.weight, now, input.sourceUrl ?? null, input.note ?? null);
    recomputeAgencyScore(input.agencyId);
    const row = db.prepare("SELECT * FROM trackl_signals WHERE id = ?").get(id) as SignalRow;
    return { signal: rowToSignal(row), created: true };
  }
  db.prepare("UPDATE trackl_signals SET weight = ?, note = COALESCE(?, note), observed_at = ? WHERE id = ?")
    .run(input.weight, input.note ?? null, now, existing.id);
  recomputeAgencyScore(input.agencyId);
  const row = db.prepare("SELECT * FROM trackl_signals WHERE id = ?").get(existing.id) as SignalRow;
  return { signal: rowToSignal(row), created: false };
}

// --- unmatched awards (review queue) ----------------------------------------

export type InsertUnmatchedAwardInput = {
  granteeName: string;
  state?: string | null;
  program: FundingProgram;
  amount?: number | null;
  awardDate?: string | null;
  sourceUrl: string;
};

export function insertUnmatchedAward(input: InsertUnmatchedAwardInput): { created: boolean } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM trackl_unmatched_awards
        WHERE tenant_id = ? AND grantee_name = ? AND program = ? AND COALESCE(award_date, '') = COALESCE(?, '')`,
    )
    .get(TRACK_L_TENANT, input.granteeName, input.program, input.awardDate ?? null);
  if (existing) return { created: false };
  db.prepare(`
    INSERT INTO trackl_unmatched_awards (id, tenant_id, grantee_name, state, program, amount, award_date, source_url, resolved_agency_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    randomId(),
    TRACK_L_TENANT,
    input.granteeName,
    input.state ?? null,
    input.program,
    input.amount ?? null,
    input.awardDate ?? null,
    input.sourceUrl,
    Date.now(),
  );
  return { created: true };
}

export function listUnmatchedAwards(limit = 500): UnmatchedAward[] {
  const rows = getDb()
    .prepare("SELECT * FROM trackl_unmatched_awards WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(TRACK_L_TENANT, limit) as Array<{
    id: string;
    tenant_id: string;
    grantee_name: string;
    state: string | null;
    program: string;
    amount: number | null;
    award_date: string | null;
    source_url: string;
    resolved_agency_id: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    granteeName: r.grantee_name,
    state: r.state,
    program: isFundingProgram(r.program) ? r.program : "OTHER",
    amount: r.amount,
    awardDate: r.award_date,
    sourceUrl: r.source_url,
    resolvedAgencyId: r.resolved_agency_id,
  }));
}

// --- scoring (§3 — exact weights authoritative) -----------------------------

const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

/**
 * Recompute score + tier + reason codes for one agency from its funding
 * events, signals, and demographic fields. One reason-code string per
 * contributing input (mandatory — a nonzero score with empty reason codes is
 * an acceptance failure). AWARD_RECENT takes the strongest qualifying award
 * (max, not sum) so an agency with 3 award rows of the same grant cycle
 * doesn't triple-count; every qualifying award still gets its reason code.
 */
export function recomputeAgencyScore(agencyId: string, now = Date.now()): HealthAgency | null {
  const db = getDb();
  const agencyRow = db
    .prepare("SELECT * FROM trackl_agencies WHERE id = ? AND tenant_id = ?")
    .get(agencyId, TRACK_L_TENANT) as AgencyRow | undefined;
  if (!agencyRow) return null;

  const events = (
    db.prepare("SELECT * FROM trackl_funding_events WHERE agency_id = ? AND tenant_id = ?").all(agencyId, TRACK_L_TENANT) as EventRow[]
  ).map(rowToEvent);
  const signals = (
    db.prepare("SELECT * FROM trackl_signals WHERE agency_id = ? AND tenant_id = ?").all(agencyId, TRACK_L_TENANT) as SignalRow[]
  ).map(rowToSignal);

  let score = 0;
  const reasons: string[] = [];

  // AWARD_RECENT: +40 linear decay to +20 at month 12; 0 past 12 months.
  let bestAward = 0;
  for (const ev of events) {
    if (!ev.awardDate) continue;
    const t = Date.parse(ev.awardDate);
    if (!Number.isFinite(t)) continue;
    const monthsAgo = (now - t) / MS_PER_MONTH;
    if (monthsAgo < 0 || monthsAgo > 12) continue;
    const w = Math.round(40 - (20 * monthsAgo) / 12);
    bestAward = Math.max(bestAward, Math.min(40, Math.max(20, w)));
    reasons.push(
      `${programLabel(ev.program)} award${ev.amount ? ` $${formatAmount(ev.amount)}` : ""} (${ev.awardDate.slice(0, 7)})${
        ev.spendDeadline ? `, deadline ${ev.spendDeadline.slice(0, 10)}` : ""
      }`,
    );
  }
  score += bestAward;

  // SPEND_DEADLINE: any event deadline ≤ 18 months out → +10.
  const deadlineEv = events.find((ev) => {
    if (!ev.spendDeadline) return false;
    const t = Date.parse(ev.spendDeadline);
    return Number.isFinite(t) && t > now && t - now <= 18 * MS_PER_MONTH;
  });
  if (deadlineEv) {
    score += 10;
    reasons.push(`Spend deadline ${deadlineEv.spendDeadline!.slice(0, 10)} within 18 months`);
  }

  // BLOOD_LEAD_ELEVATED: agency flag or signal → +25.
  const bloodSignal = signals.find((s) => s.type === "BLOOD_LEAD_ELEVATED");
  if (agencyRow.blood_lead_elevated === 1 || bloodSignal) {
    score += 25;
    reasons.push(bloodSignal?.note ?? "Blood-lead rate above reference (surveillance flag)");
  }

  // HOUSING_PRE1978: ≥60% → +15, ≥75% → +20. Pre-1980 ACS proxy noted (§4).
  const pct = agencyRow.housing_pre1978_pct;
  if (pct != null && pct >= 60) {
    score += pct >= 75 ? 20 : 15;
    reasons.push(`Pre-1978 housing ${Math.round(pct)}% (ACS B25034 pre-1980 proxy)`);
  }

  // LSLR_MANDATE: active program participation signal → +15.
  const lslr = signals.find((s) => s.type === "LSLR_MANDATE");
  if (lslr) {
    score += 15;
    reasons.push(lslr.note ?? "Active LSLR program participation");
  }

  // NEWS_EVENT: manual flag → +5.
  const news = signals.find((s) => s.type === "NEWS_EVENT");
  if (news) {
    score += 5;
    reasons.push(news.note ?? "News event flag");
  }

  const tier: Tier = score >= 50 ? "DREAM" : score >= 20 ? "STANDARD" : "LOW";
  db.prepare("UPDATE trackl_agencies SET score = ?, reason_codes = ?, tier = ?, updated_at = ? WHERE id = ?")
    .run(score, JSON.stringify(reasons), tier, Date.now(), agencyId);
  const row = db.prepare("SELECT * FROM trackl_agencies WHERE id = ?").get(agencyId) as AgencyRow;
  return rowToAgency(row);
}

function programLabel(p: FundingProgram): string {
  switch (p) {
    case "HUD_LHC":
      return "HUD LHC";
    case "HUD_HH":
      return "HUD Healthy Homes";
    case "EPA_WIIN":
      return "EPA WIIN";
    case "LSLR_STATE":
      return "State LSLR";
    case "OPIOID":
      return "Opioid settlement";
    default:
      return "Other program";
  }
}

function formatAmount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// --- queries for the /track-l UI + API (§6/§7) ------------------------------

export type ListAgenciesFilters = {
  state?: string;
  tier?: Tier;
  program?: FundingProgram;
  scoreMin?: number;
  scoreMax?: number;
  q?: string;
  sort?: "score" | "name" | "state" | "contacts";
  limit?: number;
  offset?: number;
};

export function listAgencies(filters: ListAgenciesFilters = {}): { rows: AgencyListRow[]; total: number } {
  const db = getDb();
  const where: string[] = ["a.tenant_id = @tenant"];
  const params: Record<string, unknown> = { tenant: TRACK_L_TENANT };
  if (filters.state && /^[A-Za-z]{2}$/.test(filters.state)) {
    where.push("a.state = @state");
    params.state = filters.state.toUpperCase();
  }
  if (filters.tier && isTier(filters.tier)) {
    where.push("a.tier = @tier");
    params.tier = filters.tier;
  }
  if (filters.program && isFundingProgram(filters.program)) {
    where.push("EXISTS (SELECT 1 FROM trackl_funding_events fe WHERE fe.agency_id = a.id AND fe.program = @program)");
    params.program = filters.program;
  }
  if (filters.scoreMin != null && Number.isFinite(filters.scoreMin)) {
    where.push("a.score >= @score_min");
    params.score_min = filters.scoreMin;
  }
  if (filters.scoreMax != null && Number.isFinite(filters.scoreMax)) {
    where.push("a.score <= @score_max");
    params.score_max = filters.scoreMax;
  }
  if (filters.q && filters.q.trim()) {
    where.push("(LOWER(a.name) LIKE @q OR LOWER(COALESCE(a.county, '')) LIKE @q)");
    params.q = `%${filters.q.trim().toLowerCase()}%`;
  }

  const whereSql = where.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM trackl_agencies a WHERE ${whereSql}`).get(params) as { n: number }
  ).n;

  const order =
    filters.sort === "name"
      ? "a.name ASC"
      : filters.sort === "state"
        ? "a.state ASC, a.score DESC"
        : filters.sort === "contacts"
          ? "contact_count DESC, a.score DESC"
          : "a.score DESC, a.name ASC";
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);

  const rows = db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM trackl_contacts c WHERE c.agency_id = a.id) AS contact_count,
              (SELECT COUNT(*) FROM trackl_funding_events fe WHERE fe.agency_id = a.id) AS funding_event_count,
              (SELECT fe.program FROM trackl_funding_events fe WHERE fe.agency_id = a.id
                ORDER BY COALESCE(fe.amount, 0) DESC LIMIT 1) AS top_program
         FROM trackl_agencies a
        WHERE ${whereSql}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`,
    )
    .all(params) as Array<AgencyRow & { contact_count: number; funding_event_count: number; top_program: string | null }>;

  return {
    total: Number(total),
    rows: rows.map((r) => ({
      ...rowToAgency(r),
      contactCount: Number(r.contact_count),
      fundingEventCount: Number(r.funding_event_count),
      topProgram: r.top_program && isFundingProgram(r.top_program) ? r.top_program : null,
    })),
  };
}

export function getAgencyDetail(id: string): AgencyDetail | null {
  const db = getDb();
  const agency = getAgencyById(id);
  if (!agency) return null;
  const contacts = (
    db.prepare("SELECT * FROM trackl_contacts WHERE agency_id = ? AND tenant_id = ? ORDER BY priority ASC, email ASC").all(id, TRACK_L_TENANT) as ContactRow[]
  ).map(rowToContact);
  const fundingEvents = (
    db.prepare("SELECT * FROM trackl_funding_events WHERE agency_id = ? AND tenant_id = ? ORDER BY COALESCE(award_date, '') DESC").all(id, TRACK_L_TENANT) as EventRow[]
  ).map(rowToEvent);
  const signals = (
    db.prepare("SELECT * FROM trackl_signals WHERE agency_id = ? AND tenant_id = ? ORDER BY observed_at DESC").all(id, TRACK_L_TENANT) as SignalRow[]
  ).map(rowToSignal);
  const outreach = db
    .prepare("SELECT stage FROM trackl_outreach_status WHERE agency_id = ? AND tenant_id = ?")
    .get(id, TRACK_L_TENANT) as { stage: string } | undefined;
  return {
    ...agency,
    contacts,
    fundingEvents,
    signals,
    outreachStage: (outreach?.stage as OutreachStage) ?? "COLD",
  };
}

/** Acceptance-checklist rollup (§8) — also handy for the CLI's `stats`. */
export function trackLStats(): {
  agencies: number;
  agenciesWithFundingEvents: number;
  namedContacts: number;
  totalContacts: number;
  dreamAgencies: number;
  dreamMissingReasons: number;
  nonzeroMissingReasons: number;
  unmatchedAwards: number;
  signals: number;
  fundingEvents: number;
} {
  const db = getDb();
  const one = (sql: string) => Number((db.prepare(sql).get(TRACK_L_TENANT) as { n: number }).n);
  return {
    agencies: one("SELECT COUNT(*) n FROM trackl_agencies WHERE tenant_id = ?"),
    agenciesWithFundingEvents: one(
      "SELECT COUNT(DISTINCT agency_id) n FROM trackl_funding_events WHERE tenant_id = ?",
    ),
    namedContacts: one(
      "SELECT COUNT(*) n FROM trackl_contacts WHERE tenant_id = ? AND name IS NOT NULL AND priority IN ('P1_CLPPP','P2_HEALTH_OFFICER','P3_PIO')",
    ),
    totalContacts: one("SELECT COUNT(*) n FROM trackl_contacts WHERE tenant_id = ?"),
    dreamAgencies: one("SELECT COUNT(*) n FROM trackl_agencies WHERE tenant_id = ? AND tier = 'DREAM'"),
    dreamMissingReasons: one(
      "SELECT COUNT(*) n FROM trackl_agencies WHERE tenant_id = ? AND tier = 'DREAM' AND (reason_codes = '[]' OR reason_codes IS NULL)",
    ),
    nonzeroMissingReasons: one(
      "SELECT COUNT(*) n FROM trackl_agencies WHERE tenant_id = ? AND score > 0 AND (reason_codes = '[]' OR reason_codes IS NULL)",
    ),
    unmatchedAwards: one("SELECT COUNT(*) n FROM trackl_unmatched_awards WHERE tenant_id = ?"),
    signals: one("SELECT COUNT(*) n FROM trackl_signals WHERE tenant_id = ?"),
    fundingEvents: one("SELECT COUNT(*) n FROM trackl_funding_events WHERE tenant_id = ?"),
  };
}
