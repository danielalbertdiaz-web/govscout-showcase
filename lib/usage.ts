// Item 3.2 — Usage attribution. Visibility only: we record what every Claude
// invocation cost and which opportunity/stage/model it served. There are NO
// caps, gating, or expected-value math anywhere in this module by design.
//
// The pure half (pricing + cost math) lives at the top and is unit-tested. The
// impure half (recording + view queries) is a thin db shell at the bottom.

import { getDb } from "./db";

// --- Pure: pricing + cost ---------------------------------------------------

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

// USD per single token, by rate class. Anthropic publishes per-million-token
// pricing; these are those figures / 1e6. Cache reads bill at ~0.1x input,
// cache writes at ~1.25x input.
type Rate = { input: number; output: number; cacheRead: number; cacheWrite: number };

function rate(inputPerM: number, outputPerM: number): Rate {
  return {
    input: inputPerM / 1_000_000,
    output: outputPerM / 1_000_000,
    cacheRead: (inputPerM * 0.1) / 1_000_000,
    cacheWrite: (inputPerM * 1.25) / 1_000_000,
  };
}

// Keyed by model family substring so version bumps (opus-4-7 → opus-4-8) keep
// working without edits. Order matters: most specific first.
const PRICING: { match: (m: string) => boolean; rate: Rate }[] = [
  { match: (m) => m.includes("opus"), rate: rate(15, 75) },
  { match: (m) => m.includes("sonnet"), rate: rate(3, 15) },
  { match: (m) => m.includes("haiku"), rate: rate(1, 5) },
];

// Fallback when a model name matches nothing known — priced as Sonnet so cost is
// never silently $0 (same defensive posture as the council cost ceiling).
const FALLBACK_RATE = rate(3, 15);

export function rateForModel(model: string): Rate {
  const m = model.toLowerCase();
  return PRICING.find((p) => p.match(m))?.rate ?? FALLBACK_RATE;
}

export function estimateCostUsd(model: string, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  const r = rateForModel(model);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    input * r.input +
    output * r.output +
    cacheRead * r.cacheRead +
    cacheWrite * r.cacheWrite
  );
}

// --- Impure: recording ------------------------------------------------------

export type UsageAttribution = {
  userEmail?: string | null;
  opportunityId?: string | null;
  draftId?: string | null;
  stage?: string | null;
  source?: string | null;
};

export type UsageEvent = {
  id: string;
  createdAt: number;
  userEmail: string | null;
  opportunityId: string | null;
  draftId: string | null;
  stage: string;
  source: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Append one usage event. NEVER throws — a logging failure must not break the
// generation it's measuring. Cost is computed from the model + token usage.
export function recordUsageEvent(
  model: string,
  usage: TokenUsage | undefined,
  attribution: UsageAttribution = {},
): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO usage_events (
        id, created_at, user_email, opportunity_id, draft_id, stage, source,
        model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      ) VALUES (
        @id, @created_at, @user_email, @opportunity_id, @draft_id, @stage, @source,
        @model, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @cost_usd
      )`,
    ).run({
      id: randomId(),
      created_at: Date.now(),
      user_email: attribution.userEmail ?? null,
      opportunity_id: attribution.opportunityId ?? null,
      draft_id: attribution.draftId ?? null,
      stage: attribution.stage ?? "uncategorized",
      source: attribution.source ?? null,
      model,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage?.cache_creation_input_tokens ?? 0,
      cost_usd: estimateCostUsd(model, usage),
    });
  } catch (err) {
    // Visibility is best-effort; swallow so the caller's stream is unaffected.
    console.error("recordUsageEvent failed:", err instanceof Error ? err.message : err);
  }
}

// --- Impure: aggregation reads (live views, never stored totals) ------------

export type UsageRollup = {
  key: string | null;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

type RollupRow = {
  k: string | null;
  events: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

function mapRollup(rows: RollupRow[]): UsageRollup[] {
  return rows.map((r) => ({
    key: r.k,
    events: Number(r.events) || 0,
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
  }));
}

export function usageByStage(): UsageRollup[] {
  const db = getDb();
  return mapRollup(
    db
      .prepare(
        "SELECT stage AS k, events, input_tokens, output_tokens, cost_usd FROM usage_by_stage ORDER BY cost_usd DESC",
      )
      .all() as RollupRow[],
  );
}

export function usageByModel(): UsageRollup[] {
  const db = getDb();
  return mapRollup(
    db
      .prepare(
        "SELECT model AS k, events, input_tokens, output_tokens, cost_usd FROM usage_by_model ORDER BY cost_usd DESC",
      )
      .all() as RollupRow[],
  );
}

export function usageByOpportunity(limit = 100): UsageRollup[] {
  const db = getDb();
  return mapRollup(
    db
      .prepare(
        "SELECT opportunity_id AS k, events, input_tokens, output_tokens, cost_usd FROM usage_by_opportunity ORDER BY cost_usd DESC LIMIT ?",
      )
      .all(limit) as RollupRow[],
  );
}

export type UsageTotals = {
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export function usageTotals(): UsageTotals {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS events, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM usage_events`,
    )
    .get() as { events: number; input_tokens: number; output_tokens: number; cost_usd: number };
  return {
    events: Number(row.events) || 0,
    inputTokens: Number(row.input_tokens) || 0,
    outputTokens: Number(row.output_tokens) || 0,
    costUsd: Number(row.cost_usd) || 0,
  };
}

export function listRecentUsageEvents(limit = 50): UsageEvent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: Number(r.created_at),
    userEmail: (r.user_email as string | null) ?? null,
    opportunityId: (r.opportunity_id as string | null) ?? null,
    draftId: (r.draft_id as string | null) ?? null,
    stage: String(r.stage),
    source: (r.source as string | null) ?? null,
    model: String(r.model),
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
    cacheReadTokens: Number(r.cache_read_tokens) || 0,
    cacheCreationTokens: Number(r.cache_creation_tokens) || 0,
    costUsd: Number(r.cost_usd) || 0,
  }));
}
