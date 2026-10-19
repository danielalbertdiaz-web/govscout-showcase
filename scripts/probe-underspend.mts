/**
 * One-off LIVE back-test for the underspend lane (USASpending.gov, no key).
 * Run: node --import tsx scripts/probe-underspend.mts
 *
 * Verifies the unverified-at-build assumptions: (1) the request schema is
 * accepted by the live endpoint, (2) the response field names match the
 * tolerant parser, (3) the registry + ranker produce sensible pools.
 */

import { currentFederalFiscalYear } from "../lib/underspend-sources/usaspending";
import { searchUnderspendSources } from "../lib/underspend-sources/index";
import {
  rankUnderspend,
  isPersistableUnderspend,
  DEFAULT_UNDERSPEND_KEYWORDS,
  EL_HOME_STATES,
  UNDERSPEND_THRESHOLD,
} from "../lib/underspend-scoring";
import { formatMoneyShort } from "../lib/underspend-sources/types";

const fy = currentFederalFiscalYear();
console.log(`\n=== USASpending LIVE probe — FY${fy} (two-step adapter) ===`);

console.log(`\n=== registry searchUnderspendSources ===`);
const found = await searchUnderspendSources({
  keywords: DEFAULT_UNDERSPEND_KEYWORDS,
  states: [...EL_HOME_STATES],
  minUnspent: 100_000,
  fiscalYear: fy,
  limit: 40,
});
console.log(`sourcesUsed: ${found.sourcesUsed.join(", ") || "(none)"} | records: ${found.records.length}`);

const ranked = rankUnderspend({
  records: found.records,
  ctx: { keywords: DEFAULT_UNDERSPEND_KEYWORDS, homeStates: [...EL_HOME_STATES] },
  limit: 40,
}).filter((x) => isPersistableUnderspend(x));

console.log(`\n=== persistable (score>=${UNDERSPEND_THRESHOLD} & on-theme): ${ranked.length} ===`);
for (const x of ranked.slice(0, 10)) {
  console.log(`  [${x.score}] ${x.record.name} — ${formatMoneyShort(x.record.unspent)} unspent`);
  console.log(`        ${x.reasons.join(" · ")}`);
}
console.log("");
