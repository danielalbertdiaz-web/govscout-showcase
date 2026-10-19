import { promises as fs } from "fs";
import os from "os";
import path from "path";

// Partner schema v2 (2026-06-03). The previous shape was an array of
// rich records; this is a leaner dict-keyed-by-id alongside two lookup
// tables for opportunity-driven auto-selection. Rich prose still lives in
// the companion `<id>.md` files which we load on demand into `body`.
export type Partner = {
  id: string;
  name: string;
  type: string;
  description: string;
  capabilities: string[];
  commission_structure: string;
  integration_notes: string;
  contact: string;
  status: string;
};

export type PartnerWithBody = Partner & { body: string | null };

export type PartnerSummary = {
  id: string;
  name: string;
  type: string;
  description: string;
  capabilities: string[];
};

export type PartnerIndex = {
  partners: Record<string, Partner>;
  capability_mapping: Record<string, string[]>;
  auto_match_rules: {
    keywords?: Record<string, string[]>;
    opportunity_types?: Record<string, string[]>;
  };
  metadata: Record<string, unknown>;
};

const DEFAULT_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "partner-capabilities",
);

function partnersDir(): string {
  return process.env.PARTNER_CAPABILITIES_DIR?.trim() || DEFAULT_DIR;
}

const CACHE_TTL_MS = 5_000;
let cache: { at: number; index: PartnerIndex } | null = null;

const EMPTY_INDEX: PartnerIndex = {
  partners: {},
  capability_mapping: {},
  auto_match_rules: {},
  metadata: {},
};

async function readIndex(): Promise<PartnerIndex> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.index;
  const indexPath = path.join(partnersDir(), "index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    const idx = normalizeIndex(parsed);
    cache = { at: now, index: idx };
    return idx;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      cache = { at: now, index: EMPTY_INDEX };
      return EMPTY_INDEX;
    }
    throw err;
  }
}

// Accept both v2 (dict) and v1 (array) shapes. V1 partners get coerced
// into the v2 record with empty capability/rule tables — keeps the file
// loader robust if Alfred re-drops the old format during a rollback.
function normalizeIndex(parsed: unknown): PartnerIndex {
  if (Array.isArray(parsed)) {
    const partners: Record<string, Partner> = {};
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = String(e.id ?? "").trim();
      if (!id) continue;
      partners[id] = {
        id,
        name: String(e.name ?? id),
        type: String(e.type ?? ""),
        description: String(e.summary ?? e.description ?? ""),
        capabilities: [],
        commission_structure: "",
        integration_notes: String(e.partnership_posture ?? ""),
        contact: "",
        status: "active",
      };
    }
    return { partners, capability_mapping: {}, auto_match_rules: {}, metadata: {} };
  }
  if (parsed && typeof parsed === "object") {
    const p = parsed as Record<string, unknown>;
    const partnersRaw = p.partners;
    const partners: Record<string, Partner> = {};
    if (partnersRaw && typeof partnersRaw === "object" && !Array.isArray(partnersRaw)) {
      for (const [id, val] of Object.entries(partnersRaw as Record<string, unknown>)) {
        if (!val || typeof val !== "object") continue;
        const v = val as Record<string, unknown>;
        partners[id] = {
          id,
          name: String(v.name ?? id),
          type: String(v.type ?? ""),
          description: String(v.description ?? ""),
          capabilities: Array.isArray(v.capabilities) ? v.capabilities.map(String) : [],
          commission_structure: String(v.commission_structure ?? ""),
          integration_notes: String(v.integration_notes ?? ""),
          contact: String(v.contact ?? ""),
          status: String(v.status ?? "active"),
        };
      }
    }
    return {
      partners,
      capability_mapping: (p.capability_mapping as Record<string, string[]>) ?? {},
      auto_match_rules: (p.auto_match_rules as PartnerIndex["auto_match_rules"]) ?? {},
      metadata: (p.metadata as Record<string, unknown>) ?? {},
    };
  }
  throw new Error("partner index.json: unrecognized shape");
}

// ---- Write layer ----------------------------------------------------------
//
// Authoring path for new/updated partners. Reads the raw index.json (NOT the
// normalized view — we must preserve capability_mapping, auto_match_rules, and
// any keys we don't model), mutates the single partner, and writes atomically
// (temp file + rename) so a crash mid-write can't truncate the manifest.

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// A partner id is also a filename (`<id>.md`) and a JSON key, so it must be a
// strict, dot-free, slash-free slug. This is the single guard that prevents a
// caller- or model-supplied id (e.g. "../../etc/foo") from escaping the
// partner directory on write. Mirrors what slugify() produces by construction.
const SAFE_PARTNER_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

function assertSafePartnerId(id: string): void {
  if (!SAFE_PARTNER_ID.test(id)) {
    throw new Error("invalid partner id (must match ^[a-z0-9][a-z0-9-]{0,79}$)");
  }
}

// Serialize the partner-manifest read-modify-write so two concurrent upserts
// can't silently clobber each other (lost-update). The index is a single
// shared JSON file; the atomic temp+rename in writeRawIndex prevents torn
// files but not interleaved read→mutate→write races. This in-process mutex
// chains writes within the one server instance — sufficient for a single-user
// tool. (Durable multi-instance answer = move partners into SQLite.)
let partnerWriteChain: Promise<unknown> = Promise.resolve();

function withPartnerWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = partnerWriteChain.then(fn, fn);
  // Keep the chain alive after either outcome without leaking rejections.
  partnerWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

type RawIndex = {
  partners: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

async function readRawIndex(): Promise<RawIndex> {
  const indexPath = path.join(partnersDir(), "index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    // v1 array shape → coerce to v2 dict, preserving nothing else (array form
    // carries no mapping tables).
    if (Array.isArray(parsed)) {
      const partners: Record<string, Record<string, unknown>> = {};
      for (const e of parsed) {
        if (e && typeof e === "object" && (e as Record<string, unknown>).id) {
          partners[String((e as Record<string, unknown>).id)] = e as Record<string, unknown>;
        }
      }
      return { partners };
    }
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      const partners =
        p.partners && typeof p.partners === "object" && !Array.isArray(p.partners)
          ? (p.partners as Record<string, Record<string, unknown>>)
          : {};
      return { ...p, partners };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  return { partners: {} };
}

async function writeRawIndex(idx: RawIndex): Promise<void> {
  const dir = partnersDir();
  await fs.mkdir(dir, { recursive: true });
  const indexPath = path.join(dir, "index.json");
  const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(idx, null, 2), "utf8");
  await fs.rename(tmpPath, indexPath);
  cache = null; // bust the read cache so the next read sees the write
}

export type UpsertPartnerInput = {
  id?: string;
  name: string;
  type?: string;
  description?: string;
  capabilities?: string[];
  commission_structure?: string;
  integration_notes?: string;
  contact?: string;
  status?: string;
  body?: string | null; // markdown reference profile → written to <id>.md
};

export async function upsertPartner(input: UpsertPartnerInput): Promise<Partner> {
  const name = input.name?.trim();
  if (!name) throw new Error("partner name required");

  // A caller- or model-supplied id is untrusted input that becomes a filename;
  // require it to be a strict safe slug. (Reject before touching the manifest.)
  const explicitId = (input.id ?? "").trim();
  if (explicitId) assertSafePartnerId(explicitId);

  // Whole read-modify-write runs under the mutex so concurrent saves serialize.
  return withPartnerWriteLock(async () => {
    const idx = await readRawIndex();

    // Resolve id: a validated explicit id wins; otherwise slug from name,
    // suffixed to stay unique so an "add" never silently clobbers a partner.
    let id: string;
    if (explicitId) {
      id = explicitId;
    } else {
      id = slugify(name);
      if (!id) throw new Error("partner name yields an empty id");
      let candidate = id;
      let n = 2;
      while (idx.partners[candidate]) candidate = `${id}-${n++}`;
      id = candidate;
    }
    // Defense in depth: id is already slug-shaped, so this should never fail —
    // it guards against any future code path that mutates id between here and
    // the write.
    assertSafePartnerId(id);

    const existing = (idx.partners[id] ?? {}) as Partial<Partner>;
    const merged: Partner = {
      id,
      name,
      type: input.type ?? existing.type ?? "",
      description: input.description ?? existing.description ?? "",
      capabilities: input.capabilities ?? existing.capabilities ?? [],
      commission_structure: input.commission_structure ?? existing.commission_structure ?? "",
      integration_notes: input.integration_notes ?? existing.integration_notes ?? "",
      contact: input.contact ?? existing.contact ?? "",
      status: input.status ?? existing.status ?? "active",
    };

    idx.partners[id] = { ...existing, ...merged };
    await writeRawIndex(idx);

    if (input.body != null) {
      const dir = partnersDir();
      await fs.mkdir(dir, { recursive: true });
      // Resolve the final path and assert it stays inside the partner dir
      // before writing — belt-and-suspenders over the id-slug guard.
      const filePath = path.resolve(dir, `${id}.md`);
      const dirPrefix = path.resolve(dir) + path.sep;
      if (!filePath.startsWith(dirPrefix)) {
        throw new Error("resolved partner path escapes the partner directory");
      }
      await fs.writeFile(filePath, input.body, "utf8");
    }

    return merged;
  });
}

export async function listPartners(): Promise<PartnerSummary[]> {
  const idx = await readIndex();
  return Object.values(idx.partners)
    .filter((p) => p.status !== "inactive")
    .map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      description: p.description,
      capabilities: p.capabilities,
    }));
}

export async function loadPartners(ids?: string[]): Promise<PartnerWithBody[]> {
  const idx = await readIndex();
  const all = Object.values(idx.partners).filter((p) => p.status !== "inactive");
  const selected = ids && ids.length
    ? ids.map((id) => idx.partners[id]).filter((p): p is Partner => Boolean(p))
    : all;
  const dir = partnersDir();
  const out: PartnerWithBody[] = [];
  for (const p of selected) {
    let body: string | null = null;
    try {
      body = await fs.readFile(path.join(dir, `${p.id}.md`), "utf8");
    } catch {
      body = null;
    }
    out.push({ ...p, body });
  }
  return out;
}

// Match an opportunity description against auto_match_rules. Combines both
// keyword scans and opportunity_type tags (when the caller passes an explicit
// type hint). Returns the union of matched partner IDs. Order is stable
// (mirrors the order each rule appears in the index, which is meaningful —
// Alfred curates it).
export async function matchPartnersForOpportunity(input: {
  text: string;
  opportunityType?: string;
}): Promise<{ ids: string[]; matchedKeywords: string[]; matchedTypes: string[] }> {
  const idx = await readIndex();
  const text = (input.text ?? "").toLowerCase();
  const matched = new Set<string>();
  const matchedKeywords: string[] = [];
  const matchedTypes: string[] = [];
  const validIds = new Set(Object.keys(idx.partners));

  const keywords = idx.auto_match_rules.keywords ?? {};
  for (const [kw, ids] of Object.entries(keywords)) {
    if (!text.includes(kw.toLowerCase())) continue;
    matchedKeywords.push(kw);
    for (const id of ids) {
      if (validIds.has(id)) matched.add(id);
    }
  }

  if (input.opportunityType) {
    const types = idx.auto_match_rules.opportunity_types ?? {};
    const ids = types[input.opportunityType];
    if (ids) {
      matchedTypes.push(input.opportunityType);
      for (const id of ids) {
        if (validIds.has(id)) matched.add(id);
      }
    }
  }

  return { ids: Array.from(matched), matchedKeywords, matchedTypes };
}

// Selection policy for the orchestrator. Order of precedence:
//   1) explicit ids passed by caller (honored verbatim, even if zero matches)
//   2) auto-match against opportunity text
//   3) fall back to ALL active partners (safe default — model still does
//      semantic filtering, just at higher token cost)
// Suppressing partners entirely is the caller's job (e.g. ["__none__"]).
export async function selectPartnersForOpportunity(input: {
  explicitIds?: string[];
  opportunityText?: string;
  opportunityType?: string;
}): Promise<{
  partners: PartnerWithBody[];
  selection: { reason: "explicit" | "auto_match" | "fallback_all" | "none"; ids: string[]; matchedKeywords?: string[]; matchedTypes?: string[] };
}> {
  if (input.explicitIds && input.explicitIds.length) {
    const partners = await loadPartners(input.explicitIds);
    return { partners, selection: { reason: "explicit", ids: partners.map((p) => p.id) } };
  }
  if (input.opportunityText && input.opportunityText.trim()) {
    const match = await matchPartnersForOpportunity({
      text: input.opportunityText,
      opportunityType: input.opportunityType,
    });
    if (match.ids.length) {
      const partners = await loadPartners(match.ids);
      return {
        partners,
        selection: {
          reason: "auto_match",
          ids: partners.map((p) => p.id),
          matchedKeywords: match.matchedKeywords,
          matchedTypes: match.matchedTypes,
        },
      };
    }
  }
  const partners = await loadPartners();
  return {
    partners,
    selection: { reason: partners.length ? "fallback_all" : "none", ids: partners.map((p) => p.id) },
  };
}

// ---- Lead scoring (weighted blend) ---------------------------------------
//
// Ranks candidate partners for "who should lead this draft?" using three
// signals blended by tunable weights:
//   - capability overlap : how many of a partner's stated capabilities surface
//                          in the opportunity text (relative to the best
//                          candidate, so it's a ranking signal not an absolute)
//   - commission         : a defined, percentage-bearing commission structure
//                          is treated as more economically favorable for Acme as
//                          the lead. Assumption is documented and tunable.
//   - status             : "preferred" partners outrank plain "active".
//
// Output composite is 0..100 (weights are renormalized so partial weights
// still span the full range). Deterministic — same inputs, same ranking.

export const PARTNER_LEAD_WEIGHTS = {
  capability: 0.6,
  commission: 0.25,
  status: 0.15,
} as const;

export type PartnerLeadWeights = { capability: number; commission: number; status: number };

export type PartnerLeadScore = {
  id: string;
  name: string;
  type: string;
  score: number; // 0..100 composite
  capabilityScore: number; // 0..1 (relative to best candidate)
  commissionScore: number; // 0..1
  statusScore: number; // 0..1
  matchedCapabilities: string[];
  rationale: string;
};

export type PartnerLeadRanking = {
  ranked: PartnerLeadScore[];
  best: PartnerLeadScore | null;
  weights: PartnerLeadWeights;
};

function statusScoreOf(status: string): number {
  const s = status.trim().toLowerCase();
  if (s === "preferred" || s === "primary") return 1;
  if (s === "active" || s === "") return 0.7;
  if (s === "probation" || s === "pending") return 0.4;
  return 0.5;
}

// Higher referral percentage → more upside for Acme as the lead. Capped at 25%.
// A non-empty-but-numberless structure scores neutral; an empty one is lowest.
function commissionScoreOf(structure: string): number {
  const pct = structure.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const value = Number(pct[1]);
    if (Number.isFinite(value)) return Math.max(0, Math.min(value / 25, 1));
  }
  return structure.trim() ? 0.5 : 0.3;
}

// Count which of a partner's capabilities appear in the opportunity text.
// A capability hits if its full phrase is present, or any token >= 4 chars is.
function capabilityHits(capabilities: string[], text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const cap of capabilities) {
    const phrase = cap.trim().toLowerCase();
    if (!phrase) continue;
    if (lower.includes(phrase)) {
      hits.push(cap);
      continue;
    }
    const tokens = phrase.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (tokens.some((t) => lower.includes(t))) hits.push(cap);
  }
  return hits;
}

export async function scorePartnersForLead(input: {
  opportunityText: string;
  candidateIds?: string[];
  weights?: Partial<PartnerLeadWeights>;
}): Promise<PartnerLeadRanking> {
  const idx = await readIndex();
  const weights: PartnerLeadWeights = { ...PARTNER_LEAD_WEIGHTS, ...input.weights };
  const weightSum = weights.capability + weights.commission + weights.status || 1;

  const candidates =
    input.candidateIds && input.candidateIds.length
      ? input.candidateIds.map((id) => idx.partners[id]).filter((p): p is Partner => Boolean(p))
      : Object.values(idx.partners).filter((p) => p.status !== "inactive");

  const text = input.opportunityText ?? "";
  const hitsById = new Map<string, string[]>();
  let maxHits = 0;
  for (const p of candidates) {
    const hits = capabilityHits(p.capabilities, text);
    hitsById.set(p.id, hits);
    if (hits.length > maxHits) maxHits = hits.length;
  }

  const ranked: PartnerLeadScore[] = candidates.map((p) => {
    const hits = hitsById.get(p.id) ?? [];
    const capabilityScore = maxHits > 0 ? hits.length / maxHits : 0;
    const commissionScore = commissionScoreOf(p.commission_structure);
    const statusScore = statusScoreOf(p.status);
    const composite =
      (100 *
        (weights.capability * capabilityScore +
          weights.commission * commissionScore +
          weights.status * statusScore)) /
      weightSum;
    const rationaleParts = [
      hits.length
        ? `capability match (${hits.length}: ${hits.slice(0, 4).join(", ")})`
        : "no direct capability overlap",
      p.commission_structure ? `commission ${p.commission_structure}` : "commission unspecified",
      `status ${p.status || "active"}`,
    ];
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      score: Math.round(composite),
      capabilityScore,
      commissionScore,
      statusScore,
      matchedCapabilities: hits,
      rationale: rationaleParts.join("; "),
    };
  });

  // Sort by composite desc; break ties by capability hits then name for stability.
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.matchedCapabilities.length - a.matchedCapabilities.length ||
      a.name.localeCompare(b.name),
  );

  return { ranked, best: ranked[0] ?? null, weights };
}

// Renders selected partners as a prompt-ready block. The rich prose comes
// from the companion `<id>.md` files when available; the structured header
// just summarizes capabilities + commission posture so the model knows the
// commercial framing.
export function renderPartnersBlock(partners: PartnerWithBody[]): string {
  if (!partners.length) return "";
  const blocks = partners.map((p) => {
    const lines: string[] = [];
    lines.push(`### ${p.name} (${p.type})`);
    if (p.description) lines.push(`- Description: ${p.description}`);
    if (p.capabilities.length) lines.push(`- Capabilities: ${p.capabilities.join(", ")}`);
    if (p.commission_structure) lines.push(`- Commission/structure: ${p.commission_structure}`);
    if (p.integration_notes) lines.push(`- Integration notes: ${p.integration_notes}`);
    if (p.body) {
      lines.push("");
      lines.push("Reference profile (detailed prose — use as source of truth for any factual claims about this partner):");
      lines.push("");
      lines.push(p.body.trim());
    }
    return lines.join("\n");
  });
  return `# PARTNERSHIP CONTEXT (consortium partners available for this proposal)

The following partners can be named in scope, capability, and past-performance sections WHEN their stated capabilities and reference profiles align with the opportunity. Do NOT invent certifications, EINs, contracts, or past performance not stated in their reference profiles below. If a fact you need is not in the profile, mark it [TBD: ...].

${blocks.join("\n\n---\n\n")}`;
}
