import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { sanitizePartnerCopy } from "./partner-copy";

// LinkedIn connection schema (2026-06-03). Mirrors partner-capabilities so
// the same load + match + select pattern applies. The semantic distinction
// is downstream: partners can be named in proposals; connections are
// warm-intro prospects to recruit.
export type Connection = {
  id: string;
  name: string;
  title: string;
  company: string;
  description: string;
  industry_keywords: string[];
  connection_date: string;
  potential_partnerships: string[];
};

export type ConnectionSummary = {
  id: string;
  name: string;
  title: string;
  company: string;
  industry_keywords: string[];
};

export type ConnectionIndex = {
  connections: Record<string, Connection>;
  industry_mapping: Record<string, string[]>;
  auto_match_rules: {
    grant_keywords?: Record<string, string[]>;
    opportunity_types?: Record<string, string[]>;
  };
  metadata: Record<string, unknown>;
};

const DEFAULT_DIR = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "linkedin-connections",
);

function connectionsDir(): string {
  return process.env.LINKEDIN_CONNECTIONS_DIR?.trim() || DEFAULT_DIR;
}

const CACHE_TTL_MS = 5_000;
let cache: { at: number; index: ConnectionIndex } | null = null;

const EMPTY_INDEX: ConnectionIndex = {
  connections: {},
  industry_mapping: {},
  auto_match_rules: {},
  metadata: {},
};

async function readIndex(): Promise<ConnectionIndex> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.index;
  const indexPath = path.join(connectionsDir(), "index.json");
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

function normalizeIndex(parsed: unknown): ConnectionIndex {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("linkedin-connections/index.json: unrecognized shape");
  }
  const p = parsed as Record<string, unknown>;
  const connectionsRaw = p.connections;
  const connections: Record<string, Connection> = {};
  if (connectionsRaw && typeof connectionsRaw === "object" && !Array.isArray(connectionsRaw)) {
    for (const [id, val] of Object.entries(connectionsRaw as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const v = val as Record<string, unknown>;
      connections[id] = {
        id,
        name: String(v.name ?? id),
        title: String(v.title ?? ""),
        company: String(v.company ?? ""),
        description: String(v.description ?? ""),
        industry_keywords: Array.isArray(v.industry_keywords) ? v.industry_keywords.map(String) : [],
        connection_date: String(v.connection_date ?? ""),
        potential_partnerships: Array.isArray(v.potential_partnerships)
          ? v.potential_partnerships.map(String)
          : [],
      };
    }
  }
  return {
    connections,
    industry_mapping: (p.industry_mapping as Record<string, string[]>) ?? {},
    auto_match_rules: (p.auto_match_rules as ConnectionIndex["auto_match_rules"]) ?? {},
    metadata: (p.metadata as Record<string, unknown>) ?? {},
  };
}

export async function listConnections(): Promise<ConnectionSummary[]> {
  const idx = await readIndex();
  return Object.values(idx.connections).map((c) => ({
    id: c.id,
    name: c.name,
    title: c.title,
    company: c.company,
    industry_keywords: c.industry_keywords,
  }));
}

// Item 4.3 — surface the index metadata (e.g. total_connections claimed vs the
// enriched count actually present) so the importer can report the real gap.
export async function readConnectionsMetadata(): Promise<Record<string, unknown>> {
  const idx = await readIndex();
  return idx.metadata ?? {};
}

export async function loadConnections(ids?: string[]): Promise<Connection[]> {
  const idx = await readIndex();
  const all = Object.values(idx.connections);
  if (!ids || !ids.length) return all;
  return ids.map((id) => idx.connections[id]).filter((c): c is Connection => Boolean(c));
}

// Match grant text against grant_keywords + opportunity_types. Returns the
// union of warm-contact ids, plus the rules that fired (for transparency in
// the SSE meta event).
export async function matchConnectionsForOpportunity(input: {
  text: string;
  opportunityType?: string;
}): Promise<{ ids: string[]; matchedKeywords: string[]; matchedTypes: string[] }> {
  const idx = await readIndex();
  const text = (input.text ?? "").toLowerCase();
  const matched = new Set<string>();
  const matchedKeywords: string[] = [];
  const matchedTypes: string[] = [];
  const validIds = new Set(Object.keys(idx.connections));

  const keywords = idx.auto_match_rules.grant_keywords ?? {};
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

// Warm-contact selection policy. Unlike partner selection, the fallback for
// no-match is the EMPTY set — surfacing every connection on a generic grant
// would be noise, not signal. A miss here just means "no warm intro
// applicable; downstream may suggest cold outreach instead."
export async function selectConnectionsForOpportunity(input: {
  explicitIds?: string[];
  opportunityText?: string;
  opportunityType?: string;
}): Promise<{
  connections: Connection[];
  selection: { reason: "explicit" | "auto_match" | "none"; ids: string[]; matchedKeywords?: string[]; matchedTypes?: string[] };
}> {
  if (input.explicitIds && input.explicitIds.length) {
    const connections = await loadConnections(input.explicitIds);
    return { connections, selection: { reason: "explicit", ids: connections.map((c) => c.id) } };
  }
  if (input.opportunityText && input.opportunityText.trim()) {
    const match = await matchConnectionsForOpportunity({
      text: input.opportunityText,
      opportunityType: input.opportunityType,
    });
    if (match.ids.length) {
      const connections = await loadConnections(match.ids);
      return {
        connections,
        selection: {
          reason: "auto_match",
          ids: connections.map((c) => c.id),
          matchedKeywords: match.matchedKeywords,
          matchedTypes: match.matchedTypes,
        },
      };
    }
  }
  return { connections: [], selection: { reason: "none", ids: [] } };
}

// Acme outreach voice — production copy (reviewed 2026-06-09).
// Keeping this as a single template variable so it's hot-editable without
// touching the renderer logic. Placeholders:
//   {{name}}, {{firstName}}, {{title}}, {{company}}, {{opportunitySummary}},
//   {{matchedKeywords}}, {{senderName}}.
const DEFAULT_LINKEDIN_VOICE = `Hey {{firstName}} — hope you're well.

Acme Consulting just surfaced a federal opportunity that lines up squarely with your work on {{matchedKeywords}} at {{company}}:

{{opportunitySummary}}

We're putting together a response and I think there's a strong fit for {{company}} as a partner on the {{matchedKeywords}} scope. Quick 15-min call this week to walk you through the opportunity and the partnership structure?

— {{senderName}}, Acme Consulting`;

function applyVoiceTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function firstName(name: string): string {
  return name.split(/\s+/)[0]?.replace(/[,.\-]+$/, "") ?? name;
}

// Render a LinkedIn-message draft per warm contact. The opportunity summary
// is passed in (already trimmed by caller). matchedKeywords is the
// intersection of grant keywords and this connection's industry — used to
// personalize the "why I'm reaching out" line.
export type WarmOutreachDraft = {
  connection_id: string;
  to: { name: string; company: string; title: string };
  channel: "linkedin";
  subject: string;
  body: string;
  matched_keywords: string[];
};

export async function renderWarmOutreachDrafts(input: {
  connections: Connection[];
  opportunitySummary: string;
  matchedKeywords: string[];
  senderName?: string;
  voiceTemplate?: string;
}): Promise<WarmOutreachDraft[]> {
  const tmpl = input.voiceTemplate ?? DEFAULT_LINKEDIN_VOICE;
  const sender = input.senderName?.trim() || "Acme Partnerships";
  const drafts: WarmOutreachDraft[] = [];
  for (const c of input.connections) {
    // Per-contact matched keywords: intersect grant keywords with this
    // connection's industry tags so each draft cites the specific reason
    // this person was surfaced (not the global match list).
    const contactMatched = input.matchedKeywords.filter((kw) => {
      const k = kw.toLowerCase();
      return (
        c.industry_keywords.some((ind) => ind.toLowerCase().includes(k) || k.includes(ind.toLowerCase())) ||
        c.potential_partnerships.some((p) => p.toLowerCase().includes(k) || k.includes(p.toLowerCase())) ||
        c.title.toLowerCase().includes(k) ||
        c.description.toLowerCase().includes(k)
      );
    });
    const keywordPhrase = contactMatched.length
      ? contactMatched.slice(0, 3).join(", ")
      : c.industry_keywords.slice(0, 2).join(", ") || "this space";
    const rawBody = applyVoiceTemplate(tmpl, {
      name: c.name,
      firstName: firstName(c.name),
      title: c.title,
      company: c.company,
      opportunitySummary: input.opportunitySummary.trim(),
      matchedKeywords: keywordPhrase,
      senderName: sender,
    });
    // Item 1.6: this body is partner-facing. Strip any leaked internal copy
    // (dead-relationship names, disparaging/strategy framing) before it ever
    // becomes a reviewable draft. Nothing auto-sends; this is the render guard.
    const body = sanitizePartnerCopy(rawBody).clean;
    drafts.push({
      connection_id: c.id,
      to: { name: c.name, company: c.company, title: c.title },
      channel: "linkedin",
      subject: `Federal opportunity — possible ${keywordPhrase} partnership`,
      body,
      matched_keywords: contactMatched,
    });
  }
  return drafts;
}

// Compact prompt-block for the model. Surfaces warm contacts as
// *partnership signal* the model can mention in the proposal narrative
// (e.g. "Acme maintains warm relationships with industry leaders in X").
// Does NOT include LinkedIn messages — those go in SSE meta for the UI,
// not the proposal text.
export function renderWarmContactsBlock(connections: Connection[]): string {
  if (!connections.length) return "";
  const lines = connections.map((c) => {
    const tags = c.industry_keywords.slice(0, 4).join(", ");
    return `- ${c.name} — ${c.title}${c.company ? `, ${c.company}` : ""}${tags ? ` [${tags}]` : ""}`;
  });
  return `# WARM NETWORK SIGNAL (private — do not name individuals in the proposal)

Acme Consulting maintains warm professional relationships relevant to this opportunity. You MAY allude to "established relationships with industry leaders in [domain]" when narratively appropriate. Do NOT name specific individuals or companies from this list in the proposal — these are private network signals, not consortium partners.

${lines.join("\n")}`;
}
