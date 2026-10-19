/** Track L §8 acceptance rollup. Run: node --import tsx scripts/track-l/stats.mts */
import { trackLStats } from "../../lib/track-l";

const s = trackLStats();
console.log(JSON.stringify(s, null, 2));
const checks: Array<[string, boolean]> = [
  ["≥1,500 agencies", s.agencies >= 1500],
  ["≥200 agencies w/ ≥1 FundingEvent", s.agenciesWithFundingEvents >= 200],
  ["≥500 named-person contacts (P1–P3)", s.namedContacts >= 500],
  ["≥800 total contacts", s.totalContacts >= 800],
  ["every DREAM agency has reason codes", s.dreamMissingReasons === 0],
  ["no nonzero-score agency missing reason codes", s.nonzeroMissingReasons === 0],
];
for (const [label, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${label}`);
