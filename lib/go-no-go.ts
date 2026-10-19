// M3 — GO / NO-GO: the pursuit-decision filter (user-facing name; the engine
// underneath is the MiroFish swarm simulator, see lib/simulation.ts).
//
// One call war-games a simulated review panel on a draft's opportunity and
// files the verdict as a DECISION. Run state persists on the draft's meta
// (meta.goNoGo) so the panel can poll progress across the long (10–30 min)
// simulation. Verdicts are ADVISORY — a human always makes the actual call,
// and the engine stays untrusted until its three backtests pass.

import { getDraft, saveDraft, type DraftRecord } from "./db";
import { createDecision } from "./decisions";
import { tryLogActivity } from "./activity";
import {
  runGrantSimulation,
  simulationConfigured,
  type SimulationVerdict,
} from "./simulation";

export type GoNoGoState = {
  status: "running" | "complete" | "failed";
  startedAt: number;
  finishedAt?: number;
  verdict?: SimulationVerdict;
  error?: string;
  decisionId?: string;
};

export function readGoNoGoState(meta: Record<string, unknown> | null): GoNoGoState | null {
  const raw = meta?.goNoGo;
  if (!raw || typeof raw !== "object") return null;
  return raw as GoNoGoState;
}

function writeState(draft: DraftRecord, userEmail: string, state: GoNoGoState): void {
  const fresh = getDraft(draft.id, userEmail);
  if (!fresh) return;
  saveDraft({
    id: fresh.id,
    userEmail,
    title: fresh.title,
    business: fresh.business,
    naics: fresh.naics,
    opportunity: fresh.opportunity,
    blocks: fresh.blocks,
    structured: fresh.structured,
    sections: fresh.sections,
    meta: { ...(fresh.meta ?? {}), goNoGo: state },
    nofoId: fresh.nofoId,
    poolId: fresh.poolId,
  });
}

export function goNoGoAvailable(): boolean {
  return simulationConfigured();
}

/**
 * Fire-and-forget runner (mirrors the council's background pattern): kicks the
 * simulation, persists progress on draft meta, and files the go/no-go verdict
 * into the Decision queue when done. Returns immediately after marking the run
 * started; callers poll `readGoNoGoState`.
 */
export function startGoNoGo(draftId: string, userEmail: string): GoNoGoState | { error: string } {
  if (!goNoGoAvailable()) return { error: "not_configured" };
  const draft = getDraft(draftId, userEmail);
  if (!draft) return { error: "draft_not_found" };
  const existing = readGoNoGoState(draft.meta);
  if (existing?.status === "running" && Date.now() - existing.startedAt < 45 * 60_000) {
    return existing; // one run at a time; stale "running" (>45 min) may be retried
  }

  const state: GoNoGoState = { status: "running", startedAt: Date.now() };
  writeState(draft, userEmail, state);
  tryLogActivity({
    actor: userEmail,
    actionType: "alfred_tool_call",
    targetType: "draft",
    targetId: draftId,
    summary: `Go/No-Go simulation started for "${draft.title.slice(0, 60)}"`,
  });

  void (async () => {
    try {
      const result = await runGrantSimulation({
        nofoTitle: draft.title,
        nofoText: draft.opportunity || "(no NOFO text on draft)",
        capabilityStatement: [
          draft.business,
          "",
          draft.sections.capability_statement || "(capability statement not yet drafted)",
        ].join("\n"),
        competitiveLandscape: [],
      });

      if (!result.ok || !result.verdict) {
        writeState(draft, userEmail, {
          ...state,
          status: "failed",
          finishedAt: Date.now(),
          error: result.error ?? "unknown_failure",
        });
        return;
      }

      const v = result.verdict;
      const decision = createDecision({
        userEmail,
        question: `Go/No-Go: pursue "${draft.title}"? (simulated win probability ${v.winProbability ?? "?"}%)`,
        options: ["Pursue — address flagged weaknesses", "Pursue as-is", "No-go"],
        recommendedOption:
          v.winProbability == null
            ? null
            : v.winProbability >= 40
              ? "Pursue — address flagged weaknesses"
              : "No-go",
        recommendedReason: [
          v.weaknesses.length ? `Panel-flagged weaknesses: ${v.weaknesses.slice(0, 3).join("; ")}` : null,
          v.recommendations.length ? `Positioning: ${v.recommendations.slice(0, 2).join("; ")}` : null,
          "Advisory only — simulator unvalidated until 3 backtests pass.",
        ]
          .filter(Boolean)
          .join(" · "),
        contextType: "draft",
        contextId: draft.id,
      });

      writeState(draft, userEmail, {
        ...state,
        status: "complete",
        finishedAt: Date.now(),
        verdict: v,
        decisionId: decision.id,
      });
    } catch (err) {
      writeState(draft, userEmail, {
        ...state,
        status: "failed",
        finishedAt: Date.now(),
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
    }
  })();

  return state;
}
