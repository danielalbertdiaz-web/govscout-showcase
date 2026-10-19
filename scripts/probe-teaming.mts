/**
 * One-off LIVE probe for the SAM.gov teaming lane (needs SAM_GOV_API_KEY).
 * Run: node --import tsx --env-file=.env.local scripts/probe-teaming.mts
 *
 * Confirms the provisioned key is accepted, the request shape is valid, and the
 * tolerant parser maps real SAM.gov v2 records into TeamingNotices.
 */

import { samGovSource } from "../lib/teaming-sources/sam-gov";

console.log(`\n=== SAM.gov LIVE probe ===`);
console.log(`available (key set?): ${samGovSource.available}`);

const notices = await samGovSource.fetch({
  noticeTypes: ["Sources Sought", "Special Notice"],
  postedWithinDays: 30,
  limit: 10,
});

console.log(`notices returned: ${notices.length}`);
for (const n of notices.slice(0, 8)) {
  console.log(`\n• [${n.noticeType}] ${n.title}`);
  console.log(`    agency: ${n.agency ?? "—"} | naics: ${n.naics ?? "—"} | prime: ${n.prime ?? "—"}`);
  console.log(`    deadline: ${n.responseDeadline ?? "—"} | setAside: ${n.setAside ?? "—"}`);
  console.log(`    ${n.url ?? "(no url)"}`);
}
console.log("");
