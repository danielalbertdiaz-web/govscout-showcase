// Shared helper for A1/A2 fit-scoring. Calls streamClaude with the
// SCORE_SYSTEM_PROMPT, accumulates the full text, and parses the strict JSON
// response. Returns `null` if the model emits unparseable output — caller
// should keep the row unscored and move on (do NOT crash the batch).

import { CLI_MODEL_SECTION, resolveCliModel, streamClaude } from "./claude-cli";
import { SCORE_SYSTEM_PROMPT, buildScorePrompt, parseScoreResponse } from "./profile";
import type { UsageAttribution } from "./usage";

export type ScoreResult = { score: number; rationale: string; raw: string };

// Single scoring call. Keep this small and synchronous in token usage —
// expected output is one JSON line.
export async function scoreOpportunity(
  summary: string,
  opts?: { model?: string; signal?: AbortSignal; attribution?: UsageAttribution },
): Promise<ScoreResult | null> {
  const model = resolveCliModel(opts?.model, CLI_MODEL_SECTION);
  let acc = "";
  for await (const ev of streamClaude({
    model,
    systemPrompt: SCORE_SYSTEM_PROMPT,
    userPrompt: buildScorePrompt(summary),
    maxTokens: 512,
    signal: opts?.signal,
    attribution: opts?.attribution
      ? { stage: "scoring", source: "scoring", ...opts.attribution }
      : undefined,
  })) {
    if (ev.type === "delta") acc += ev.text;
    else if (ev.type === "done" && typeof ev.result === "string" && ev.result.length > acc.length) {
      acc = ev.result;
    } else if (ev.type === "error") {
      return null;
    }
  }
  const parsed = parseScoreResponse(acc);
  if (!parsed) return null;
  return { ...parsed, raw: acc };
}

// Render a dense single-string summary for a scout item used by the model.
export function scoutItemSummary(item: {
  title: string;
  agency: string | null;
  deadlineText: string | null;
  fundingText: string | null;
  naics: string | null;
  url: string | null;
  rawText: string;
  source: string;
}): string {
  const lines = [
    `Title: ${item.title}`,
    item.agency ? `Agency: ${item.agency}` : null,
    item.deadlineText ? `Deadline: ${item.deadlineText}` : null,
    item.fundingText ? `Funding: ${item.fundingText}` : null,
    item.naics ? `NAICS: ${item.naics}` : null,
    `Source bucket: ${item.source}`,
    item.url ? `URL: ${item.url}` : null,
    "",
    "Raw:",
    item.rawText.slice(0, 2500),
  ].filter(Boolean);
  return lines.join("\n");
}

// Render a dense single-string summary for a NOFO record.
export function nofoSummary(n: {
  agency: string | null;
  program: string | null;
  fundingFloor: string | null;
  fundingCeiling: string | null;
  periodOfPerformance: string | null;
  eligibility: string | null;
  summary: string | null;
  rawText: string;
  tags: string[];
  originalFilename: string | null;
}): string {
  const lines = [
    n.agency ? `Agency: ${n.agency}` : null,
    n.program ? `Program: ${n.program}` : null,
    n.fundingFloor || n.fundingCeiling
      ? `Funding: ${n.fundingFloor ?? "?"} – ${n.fundingCeiling ?? "?"}`
      : null,
    n.periodOfPerformance ? `Period of performance: ${n.periodOfPerformance}` : null,
    n.eligibility ? `Eligibility: ${n.eligibility}` : null,
    n.tags.length ? `Tags: ${n.tags.join(", ")}` : null,
    n.originalFilename ? `File: ${n.originalFilename}` : null,
    "",
    "Summary:",
    n.summary ?? "(none)",
    "",
    "Raw excerpt:",
    n.rawText.slice(0, 2500),
  ].filter(Boolean);
  return lines.join("\n");
}
