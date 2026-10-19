/**
 * M1 — govscout-sim: war-game a draft's grant competition through MiroFish.
 * Run: node --import tsx --env-file=.env.local scripts/govscout-sim.mts <draftId>
 *
 * Assembles the simulation bundle from GovScout's own data (the draft's NOFO/
 * opportunity text + Acme capability blocks + competitive notes), drives the
 * MiroFish pipeline, and files the verdict as a DECISION — a human always makes
 * the go/no-go call (trust gate: predictions are advisory until the spec's
 * three backtests pass).
 *
 * Requires: MIROFISH_BASE_URL in .env.local + the MiroFish stack running.
 */

import { readFileSync } from "fs";
import { simulationConfigured, runGrantSimulation } from "../lib/simulation";
import { getDraft } from "../lib/db";
import { createDecision } from "../lib/decisions";

const draftId = process.argv[2]?.trim();
const OWNER = "hello@govscout.ai";

if (!draftId) {
  console.error("usage: govscout-sim.mts <draftId>");
  process.exit(1);
}
if (!simulationConfigured()) {
  console.error("MIROFISH_BASE_URL not set — start the MiroFish stack and add it to .env.local");
  process.exit(1);
}

const draft = getDraft(draftId, OWNER);
if (!draft) {
  console.error(`draft not found: ${draftId}`);
  process.exit(1);
}

const capability = [
  draft.business,
  "",
  draft.sections.capability_statement || "(capability statement not yet drafted)",
].join("\n");

console.log(`\n=== Grant competition simulation — "${draft.title}" ===`);
console.log("This runs a multi-round review-panel swarm — expect 10–30 minutes.\n");

const result = await runGrantSimulation({
  nofoTitle: draft.title,
  nofoText: draft.opportunity || "(no NOFO text on draft)",
  capabilityStatement: capability,
  competitiveLandscape: [], // enrich from notes/contacts as that data accrues
});

if (!result.ok || !result.verdict) {
  console.error("simulation failed:", result.error);
  process.exit(1);
}

const v = result.verdict;
console.log(`win probability: ${v.winProbability ?? "unparsed"}%`);
console.log(`weaknesses (${v.weaknesses.length}):`);
for (const w of v.weaknesses) console.log("  -", w);
console.log(`recommendations (${v.recommendations.length}):`);
for (const r of v.recommendations) console.log("  -", r);

// File the go/no-go as a human decision — never auto-acted.
const d = createDecision({
  userEmail: OWNER,
  question: `Simulated review panel: pursue "${draft.title}"? (win probability ${v.winProbability ?? "?"}%)`,
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
console.log(`\nfiled decision ${d.id} → /decisions`);
