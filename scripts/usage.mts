// Item 3.2 — terminal view of the usage ledger. Run with `pnpm usage`.
// Visibility only: prints totals + by-stage / by-model / by-opportunity
// rollups straight from the live SQLite views. No caps, no budgets.

import {
  usageTotals,
  usageByStage,
  usageByModel,
  usageByOpportunity,
  listRecentUsageEvents,
  type UsageRollup,
} from "../lib/usage";

function fmtUsd(n: number): string {
  if (n === 0) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function printRollup(title: string, rows: UsageRollup[]): void {
  console.log(`\n=== ${title} ===`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const r of rows) {
    const key = (r.key ?? "—").padEnd(28).slice(0, 28);
    console.log(
      `  ${key}  ${String(r.events).padStart(4)} calls   in ${fmtTokens(
        r.inputTokens,
      ).padStart(7)}  out ${fmtTokens(r.outputTokens).padStart(7)}   ${fmtUsd(r.costUsd)}`,
    );
  }
}

const totals = usageTotals();
console.log("=== Usage totals ===");
console.log(`  invocations: ${totals.events}`);
console.log(`  input:       ${fmtTokens(totals.inputTokens)} tokens`);
console.log(`  output:      ${fmtTokens(totals.outputTokens)} tokens`);
console.log(`  cost:        ${fmtUsd(totals.costUsd)}`);

if (totals.events === 0) {
  console.log("\nNo usage recorded yet.");
  process.exit(0);
}

printRollup("By stage", usageByStage());
printRollup("By model", usageByModel());
printRollup("By opportunity (top 25)", usageByOpportunity(25));

const recent = listRecentUsageEvents(15);
console.log(`\n=== Recent invocations (${recent.length}) ===`);
for (const e of recent) {
  const when = new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 19);
  console.log(
    `  ${when}  ${e.stage.padEnd(20).slice(0, 20)}  ${e.model
      .replace(/^claude-/, "")
      .padEnd(16)
      .slice(0, 16)}  in ${fmtTokens(e.inputTokens).padStart(7)}  out ${fmtTokens(
      e.outputTokens,
    ).padStart(7)}  ${fmtUsd(e.costUsd)}`,
  );
}
