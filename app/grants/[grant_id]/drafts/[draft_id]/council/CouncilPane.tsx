"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CouncilRun, AgentOutput } from "@/lib/council";

type Props = {
  draftId: string;
  draftTitle: string;
  opportunityTitle: string;
};

type AgentStatus = "pending" | "running" | "complete" | "failed";

type AgentDisplayInfo = {
  agent: AgentOutput["agent"];
  name: string;
  icon: string;
  description: string;
};

const AGENTS: AgentDisplayInfo[] = [
  {
    agent: "refiner",
    name: "Refiner",
    icon: "🔍",
    description: "Stress-tests draft before council review"
  },
  {
    agent: "domain_expert",
    name: "Domain Expert",
    icon: "📚",
    description: "Applies funder's scoring rubric"
  },
  {
    agent: "contrarian",
    name: "Contrarian",
    icon: "⚔️",
    description: "Challenges expert recommendations"
  },
  {
    agent: "budget_reviewer",
    name: "Budget Reviewer",
    icon: "💰",
    description: "Audits budget compliance"
  },
  {
    agent: "executor",
    name: "Executor",
    icon: "⚡",
    description: "Creates concrete execution plan"
  },
  {
    agent: "synthesizer",
    name: "Synthesizer",
    icon: "✨",
    description: "Produces final revised draft"
  },
];

type DecisionSummaryItem = {
  importance?: string;
};

type RevisionPlanItem = {
  change?: string;
  source_agent?: string;
  contrarian_status?: string;
  refutation_reasoning?: string;
};

function isDecisionSummaryItem(value: unknown): value is DecisionSummaryItem {
  return Boolean(value) && typeof value === "object";
}

function isRevisionPlanItem(value: unknown): value is RevisionPlanItem {
  return Boolean(value) && typeof value === "object";
}

export function CouncilPane({ draftId, draftTitle, opportunityTitle }: Props) {
  const [councilRuns, setCouncilRuns] = useState<CouncilRun[]>([]);
  const [currentRun, setCurrentRun] = useState<CouncilRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startingCouncil, setStartingCouncil] = useState(false);
  const [shouldAutoTrigger, setShouldAutoTrigger] = useState(false);
  // Guards the eligibility-based auto-trigger so it fires at most once per mount,
  // even under React's double-invoked effects and repeated data refreshes.
  const autoTriggeredRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Fetch council runs for this draft
  const fetchCouncilData = useCallback(async () => {
    try {
      const response = await fetch(`/api/drafts/${draftId}/council`);
      if (!response.ok) {
        throw new Error(`Failed to fetch council data: ${response.statusText}`);
      }
      const data = await response.json();
      setCouncilRuns(data.council_runs || []);
      setCurrentRun(data.latest_run);
      setShouldAutoTrigger(data.should_auto_trigger || false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load council data");
    } finally {
      setLoading(false);
    }
  }, [draftId]);

  // Poll for council run updates
  const pollCouncilRun = useCallback(async (runId: string) => {
    clearPollTimer();

    const poll = async () => {
      try {
        const response = await fetch(`/api/council/${runId}`);
        if (!response.ok) {
          throw new Error(`Polling failed: ${response.statusText}`);
        }

        const run: CouncilRun = await response.json();
        setCurrentRun(run);

        if (run.status === "complete" || run.status === "failed") {
          void fetchCouncilData();
        } else {
          pollTimerRef.current = window.setTimeout(() => {
            void poll();
          }, 2000);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Polling failed");
      }
    };

    await poll();
  }, [clearPollTimer, fetchCouncilData]);

  // Start a new council run
  const startCouncilRun = useCallback(async (triggerType: "manual" | "auto" = "manual") => {
    setStartingCouncil(true);
    setError(null);

    try {
      const response = await fetch(`/api/drafts/${draftId}/council`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger_type: triggerType })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Failed to start council: ${response.statusText}`);
      }

      const data = await response.json();

      // Start polling for updates
      void pollCouncilRun(data.council_run_id);

    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start council run");
    } finally {
      setStartingCouncil(false);
    }
  }, [draftId, pollCouncilRun]);

  // Submit human decision
  const submitHumanDecision = async (
    decision: "submit" | "needs_more_review" | "reject",
    checklistAck: boolean
  ) => {
    if (!currentRun) return;

    try {
      const response = await fetch(`/api/council/${currentRun.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ human_decision: decision, checklist_ack: checklistAck })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        throw new Error(errData?.error || "Failed to submit decision");
      }

      const updatedRun = await response.json();
      setCurrentRun(updatedRun);

    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit decision");
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchCouncilData();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      clearPollTimer();
    };
  }, [clearPollTimer, fetchCouncilData]);

  // Eligibility-based auto-trigger (P1-1). When a draft is auto-drafted and
  // scored ≥9/10, the council is supposed to run automatically. Previously this
  // only relabeled the empty state — no run was ever started. Now we fire it
  // once, but only when there is genuinely no prior run for this draft, so we
  // never spend a deliberation on a draft a human already reviewed.
  useEffect(() => {
    if (loading) return;
    if (!shouldAutoTrigger) return;
    if (currentRun || councilRuns.length > 0) return;
    if (startingCouncil || autoTriggeredRef.current) return;

    autoTriggeredRef.current = true;
    const timer = window.setTimeout(() => {
      void startCouncilRun("auto");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentRun, councilRuns.length, loading, shouldAutoTrigger, startCouncilRun, startingCouncil]);

  if (loading) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-8 text-center shadow-sm">
        <div className="text-stone-600">Loading council data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="gs-card gs-card-lg gs-rise p-6">
        <span className="gs-eyebrow">Council Deliberation</span>
        <h1 className="mt-1 text-xl font-bold text-stone-900">
          6-agent review for <span className="text-emerald-700">{draftTitle}</span>
        </h1>
        <p className="mt-1 text-xs text-stone-500">
          Grant opportunity: {opportunityTitle}
        </p>
      </div>

      {/* Error display */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Empty state or trigger */}
      {!currentRun && (
        <div className="gs-card gs-rise border-emerald-200 bg-emerald-50/40 p-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-emerald-200 bg-white text-2xl shadow-sm">
            {shouldAutoTrigger ? "⚖️" : "🏛️"}
          </div>
          <h2 className="text-lg font-semibold text-emerald-900">
            {shouldAutoTrigger ? "Ready for Council Review" : "No Council Deliberation Yet"}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-emerald-800">
            {shouldAutoTrigger
              ? "This draft scored ≥9/10 and is eligible for automatic council review."
              : "Drafts scoring ≥9/10 auto-trigger council review. You can also manually trigger review for any draft."
            }
          </p>
          <button
            onClick={() => startCouncilRun("manual")}
            disabled={startingCouncil}
            className="gs-btn gs-btn-primary mt-5"
          >
            {startingCouncil ? "Starting Council…" : "Send to Council"}
          </button>
        </div>
      )}

      {/* Active/Complete Council Run */}
      {currentRun && (
        <CouncilRunDisplay
          run={currentRun}
          onSubmitDecision={submitHumanDecision}
          onRetry={() => startCouncilRun()}
        />
      )}

      {/* Council Run History */}
      {councilRuns.length > 0 && (
        <CouncilRunHistory runs={councilRuns} currentRunId={currentRun?.id} />
      )}
    </div>
  );
}

function CouncilRunDisplay({
  run,
  onSubmitDecision,
  onRetry
}: {
  run: CouncilRun;
  onSubmitDecision: (decision: "submit" | "needs_more_review" | "reject", checklistAck: boolean) => void;
  onRetry: () => void;
}) {
  const getAgentStatus = (agentType: AgentOutput["agent"]): AgentStatus => {
    const agent = run.agentOutputs.find(a => a.agent === agentType);
    if (!agent) return "pending";
    if (agent.failed_at) return "failed";
    if (agent.completed_at) return "complete";
    return "running";
  };

  const getProgressCount = () => {
    return run.agentOutputs.filter(a => a.completed_at).length;
  };

  const canSubmit = () => {
    return run.status === "complete" &&
           run.postScore !== null &&
           run.postScore >= 4.5 && // ≥9/10 on 5-point scale
           getSynthesizerRecommendation() === "ready_for_submission";
  };

  const getSynthesizerRecommendation = (): string => {
    const synthesizer = run.agentOutputs.find(a => a.agent === "synthesizer");
    return synthesizer?.output?.recommendation as string || "";
  };

  return (
    <div className="space-y-6">
      {/* Status Header */}
      <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <StatusIndicator status={run.status} />
              <span className="font-medium capitalize">{run.status.replace("_", " ")}</span>
            </div>
            {run.status === "running" && (
              <span className="text-sm text-stone-600">
                {getProgressCount()} of {AGENTS.length} complete...
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm">
            {run.preScore !== null && (
              <span>Pre-score: <strong>{(run.preScore * 2).toFixed(1)}/10</strong></span>
            )}
            {run.postScore !== null && (
              <span>Post-score: <strong>{(run.postScore * 2).toFixed(1)}/10</strong></span>
            )}
            {run.costUsd !== null && (
              <span className="text-stone-500">
                Cost: ${run.costUsd.toFixed(3)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Agent Columns */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {AGENTS.map((agentInfo) => (
          <AgentColumn
            key={agentInfo.agent}
            agentInfo={agentInfo}
            status={getAgentStatus(agentInfo.agent)}
            output={run.agentOutputs.find(a => a.agent === agentInfo.agent)}
          />
        ))}
      </div>

      {/* Revision Plan */}
      {run.revisionPlan && (
        <RevisionPlanDisplay revisionPlan={run.revisionPlan} />
      )}

      {/* Submit Gate */}
      {run.status === "complete" && (
        <SubmitGate
          run={run}
          canSubmit={canSubmit()}
          onSubmitDecision={onSubmitDecision}
        />
      )}

      {/* Failed State */}
      {run.status === "failed" && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <h3 className="font-semibold text-red-900">Council Run Failed</h3>
          <p className="mt-1 text-sm text-red-800">
            The council deliberation encountered an error. You can retry to run it again.
          </p>
          <button
            onClick={onRetry}
            className="mt-3 rounded-md border border-red-700 bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Retry Council Run
          </button>
        </div>
      )}
    </div>
  );
}

function AgentColumn({
  agentInfo,
  status,
  output
}: {
  agentInfo: AgentDisplayInfo;
  status: AgentStatus;
  output?: AgentOutput;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      {/* Agent Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">{agentInfo.icon}</span>
          <div>
            <h3 className="font-medium text-stone-900">{agentInfo.name}</h3>
            <p className="text-xs text-stone-500">{agentInfo.description}</p>
          </div>
        </div>
        <StatusIndicator status={status} />
      </div>

      {/* Agent Output */}
      {output && status === "complete" && (
        <div className="mt-3 space-y-2">
          {/* Key metrics/summary */}
          <AgentSummary agent={agentInfo.agent} output={output.output} />

          {/* Expand/Collapse */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-emerald-700 hover:underline"
          >
            {expanded ? "Hide details" : "Show full reasoning"}
          </button>

          {expanded && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-stone-50 p-2 text-xs text-stone-800">
              {JSON.stringify(output.output, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Loading state */}
      {status === "running" && (
        <div className="mt-3 text-center">
          <div className="text-xs text-stone-600">Working...</div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-stone-200">
            <div className="h-full w-1/2 animate-pulse bg-emerald-500"></div>
          </div>
        </div>
      )}

      {/* Error state */}
      {status === "failed" && output?.error && (
        <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-800">
          Error: {output.error}
        </div>
      )}
    </div>
  );
}

function AgentSummary({ agent, output }: { agent: string; output: Record<string, unknown> }) {
  if (agent === "refiner") {
    const skipRecommended = output.skip_council_recommended;
    const ambiguitiesCount = Array.isArray(output.ambiguities_flagged) ? output.ambiguities_flagged.length : 0;

    return (
      <div className="text-xs text-stone-700">
        <div>Skip recommended: {skipRecommended ? "Yes" : "No"}</div>
        <div>Ambiguities flagged: {ambiguitiesCount}</div>
        <div>Context refined: ✓</div>
      </div>
    );
  }

  if (agent === "domain_expert") {
    const score = typeof output.composite_score === "number" ? output.composite_score : "N/A";
    const weakSections = Array.isArray(output.top_3_weak_sections) ? output.top_3_weak_sections.length : 0;
    const complianceFlags = Array.isArray(output.compliance_flags) ? output.compliance_flags.length : 0;

    return (
      <div className="text-xs text-stone-700">
        <div>Score: {score}/5</div>
        <div>Weak sections: {weakSections}</div>
        <div>Compliance flags: {complianceFlags}</div>
      </div>
    );
  }

  if (agent === "contrarian") {
    const critiques = Array.isArray(output.expert_critiques) ? output.expert_critiques.length : 0;
    const mustAddress = Array.isArray(output.preserve_or_refute_required)
      ? output.preserve_or_refute_required.filter((x) => isDecisionSummaryItem(x) && x.importance === "must_address").length
      : 0;

    return (
      <div className="text-xs text-stone-700">
        <div>Critiques: {critiques}</div>
        <div>Must address: {mustAddress}</div>
      </div>
    );
  }

  if (agent === "budget_reviewer") {
    const budgetTotal = typeof output.budget_total === "number" ? `$${output.budget_total}` : "N/A";
    const missingElements = Array.isArray(output.missing_elements) ? output.missing_elements.length : 0;

    return (
      <div className="text-xs text-stone-700">
        <div>Budget: {budgetTotal}</div>
        <div>Missing elements: {missingElements}</div>
      </div>
    );
  }

  if (agent === "executor") {
    const revisionsCount = Array.isArray(output.ordered_revision_plan) ? output.ordered_revision_plan.length : 0;
    const decisionsCount = Array.isArray(output.decision_points_for_human) ? output.decision_points_for_human.length : 0;

    return (
      <div className="text-xs text-stone-700">
        <div>Revisions planned: {revisionsCount}</div>
        <div>Human decisions: {decisionsCount}</div>
        <div>Execution order: ✓</div>
      </div>
    );
  }

  if (agent === "synthesizer") {
    const newScore = typeof output.new_composite_score === "number" ? output.new_composite_score : "N/A";
    const scoreDelta = typeof output.score_delta === "number" ? output.score_delta : 0;
    const deltaStr = scoreDelta > 0 ? `+${scoreDelta}` : String(scoreDelta);
    const recommendation = typeof output.recommendation === "string" ? output.recommendation : "N/A";

    return (
      <div className="text-xs text-stone-700">
        <div>New score: {newScore}/5</div>
        <div>Delta: {deltaStr}</div>
        <div>Recommendation: {recommendation}</div>
      </div>
    );
  }

  return null;
}

function StatusIndicator({ status }: { status: AgentStatus | "complete" | "running" | "failed" }) {
  const colors = {
    pending: "bg-stone-300",
    running: "bg-yellow-500 animate-pulse",
    complete: "bg-green-500",
    failed: "bg-red-500",
  };

  return <div className={`h-2 w-2 rounded-full ${colors[status as keyof typeof colors]}`} />;
}

function RevisionPlanDisplay({ revisionPlan }: { revisionPlan: unknown }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold text-stone-900">Revision Plan</h3>
      <div className="mt-3 space-y-2">
        {Array.isArray(revisionPlan) && revisionPlan.filter(isRevisionPlanItem).map((item, index: number) => (
          <div key={index} className="rounded bg-stone-50 p-3 text-sm">
            <div className="font-medium">{item.change ?? "Untitled revision"}</div>
            <div className="text-xs text-stone-600">
              Source: {item.source_agent ?? "unknown"} | Status: {item.contrarian_status ?? "n/a"}
              {item.refutation_reasoning && (
                <div className="mt-1 italic">Refutation: {item.refutation_reasoning}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SubmitGate({
  run,
  canSubmit,
  onSubmitDecision
}: {
  run: CouncilRun;
  canSubmit: boolean;
  onSubmitDecision: (decision: "submit" | "needs_more_review" | "reject", checklistAck: boolean) => void;
}) {
  const [checklistChecked, setChecklistChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (decision: "submit" | "needs_more_review" | "reject") => {
    setSubmitting(true);
    await onSubmitDecision(decision, checklistChecked);
    setSubmitting(false);
  };

  const isSubmitEnabled = canSubmit && checklistChecked && !run.humanDecision;

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <h3 className="font-semibold text-emerald-900">Submission Gate</h3>

      {/* Pre-submission checklist */}
      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={checklistChecked}
            onChange={(e) => setChecklistChecked(e.target.checked)}
            className="rounded"
          />
          I have reviewed the council deliberation and revision plan
        </label>
      </div>

      {/* Status checks */}
      <div className="mt-3 space-y-1 text-xs">
        <div className={canSubmit ? "text-green-700" : "text-red-700"}>
          ✓ Post-score ≥ 9/10: {run.postScore ? (run.postScore * 2).toFixed(1) : "N/A"}/10
        </div>
        <div className={getSynthesizerRecommendation(run) === "ready_for_submission" ? "text-green-700" : "text-red-700"}>
          ✓ Recommendation: {getSynthesizerRecommendation(run)}
        </div>
      </div>

      {/* Action buttons */}
      {!run.humanDecision ? (
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => handleSubmit("submit")}
            disabled={!isSubmitEnabled || submitting}
            className="rounded-md border border-emerald-700 bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit for Review"}
          </button>
          <button
            onClick={() => handleSubmit("needs_more_review")}
            disabled={submitting}
            className="rounded-md border border-yellow-600 bg-yellow-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-yellow-700 disabled:opacity-50"
          >
            Needs More Review
          </button>
          <button
            onClick={() => handleSubmit("reject")}
            disabled={submitting}
            className="rounded-md border border-red-600 bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded bg-white p-3 text-sm">
          <strong>Decision recorded:</strong> {run.humanDecision}
          {run.humanDecisionAt && (
            <span className="text-stone-600"> on {new Date(run.humanDecisionAt).toLocaleString()}</span>
          )}
        </div>
      )}
    </div>
  );
}

function getSynthesizerRecommendation(run: CouncilRun): string {
  const synthesizer = run.agentOutputs.find(a => a.agent === "synthesizer");
  return synthesizer?.output?.recommendation as string || "";
}

function CouncilRunHistory({ runs, currentRunId }: { runs: CouncilRun[]; currentRunId?: string }) {
  const historyRuns = runs.filter(r => r.id !== currentRunId);

  if (historyRuns.length === 0) return null;

  return (
    <details className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer font-semibold text-stone-900">
        Council History ({historyRuns.length} previous run{historyRuns.length === 1 ? "" : "s"})
      </summary>
      <div className="mt-4 space-y-3">
        {historyRuns.map((run) => (
          <div key={run.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <StatusIndicator status={run.status} />
                <span className="capitalize">{run.status}</span>
                <span className="text-stone-500">
                  {new Date(run.triggeredAt).toLocaleString()}
                </span>
              </div>
              <div className="text-xs text-stone-600">
                {run.preScore && run.postScore && (
                  <span>{(run.preScore * 2).toFixed(1)} → {(run.postScore * 2).toFixed(1)}</span>
                )}
                {run.costUsd && <span className="ml-2">${run.costUsd.toFixed(3)}</span>}
              </div>
            </div>
            {run.humanDecision && (
              <div className="mt-1 text-xs text-stone-600">
                Decision: <span className="font-medium">{run.humanDecision}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
