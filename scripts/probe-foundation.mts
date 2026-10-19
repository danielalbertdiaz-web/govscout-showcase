/**
 * LIVE probe for the ProPublica foundation lane (free, no key).
 * Run: node --import tsx scripts/probe-foundation.mts
 */

import { propublicaFoundationSource } from "../lib/foundation-sources/propublica";

console.log(`\n=== ProPublica foundation funder-prospect probe (NJ/FL) ===`);
console.log(`available: ${propublicaFoundationSource.available}`);

const grants = await propublicaFoundationSource.fetch({
  themes: ["substance_use", "behavioral_health"],
  limit: 12,
});

console.log(`funder prospects: ${grants.length}\n`);
for (const g of grants.slice(0, 10)) {
  console.log(`• ${g.funder}  [${g.geography ?? "—"}]`);
  console.log(`    ${g.fundingMax ? `est. giving ${g.fundingMax} · ` : ""}${g.focusAreas.join(", ") || "no theme tag"}`);
  console.log(`    ${g.url ?? "(no url)"}`);
}
console.log("");
