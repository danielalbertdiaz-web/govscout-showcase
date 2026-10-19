import {
  selectConnectionsForOpportunity,
  renderWarmOutreachDrafts,
  renderWarmContactsBlock,
  listConnections,
} from "../lib/connections";

const tests = [
  { name: "AI grant", opportunity: "Federal AI research grant for artificial intelligence applications in government services." },
  { name: "Supply chain RFP", opportunity: "DOD logistics and supply chain modernization contract." },
  { name: "Healthcare grant", opportunity: "HHS healthcare data analytics innovation grant." },
  { name: "Office supplies (expect none)", opportunity: "GSA office supplies procurement." },
  { name: "Explicit ids", explicitIds: ["sabrina_amjad", "bill_dreher"], opportunity: "anything" },
  { name: "Suppression sentinel (simulated by route)", explicitIds: ["__none__"], opportunity: "anything" },
];

console.log("=== listConnections sanity ===");
const all = await listConnections();
console.log(`  total: ${all.length} (expected 19)`);

for (const t of tests) {
  console.log(`\n=== ${t.name} ===`);
  const suppress = t.explicitIds?.length === 1 && t.explicitIds[0] === "__none__";
  if (suppress) { console.log("  reason: suppressed (sentinel — handled in route, not select())"); continue; }
  const { connections, selection } = await selectConnectionsForOpportunity({
    explicitIds: t.explicitIds,
    opportunityText: t.opportunity,
  });
  console.log(`  reason: ${selection.reason}`);
  console.log(`  ids: [${selection.ids.join(", ")}]`);
  if (selection.matchedKeywords?.length) console.log(`  kws: [${selection.matchedKeywords.join(", ")}]`);
  if (connections.length) {
    const drafts = await renderWarmOutreachDrafts({
      connections, opportunitySummary: t.opportunity, matchedKeywords: selection.matchedKeywords ?? [],
    });
    console.log(`  drafts generated: ${drafts.length}`);
    if (drafts[0]) {
      console.log(`  --- sample draft (${drafts[0].connection_id}) ---`);
      console.log(`  subject: ${drafts[0].subject}`);
      console.log(`  body: ${drafts[0].body.slice(0, 220).replace(/\n/g, " \\n ")}`);
    }
    const block = renderWarmContactsBlock(connections);
    console.log(`  warmBlock chars: ${block.length}`);
  }
}
