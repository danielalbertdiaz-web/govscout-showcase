/**
 * One-off LIVE probe for the Apify lane (needs APIFY_TOKEN).
 * Run: node --import tsx --env-file=.env.local scripts/probe-apify.mts
 *
 * ZERO-COST by design: it only validates the credential against /users/me and
 * reports the plan + monthly usage. It does NOT run an actor (which would spend
 * compute against the free-tier budget). End-to-end actor proof is a separate,
 * explicitly-requested step.
 */

import { getApifyToken, APIFY_BASE } from "../lib/apify";

const token = getApifyToken();
console.log(`\n=== Apify LIVE probe (zero-cost auth check) ===`);
console.log(`token present & well-formed: ${Boolean(token)}`);
if (!token) {
  console.log("APIFY_TOKEN missing/short — lane stays dark. Nothing to check.");
  process.exit(0);
}

const res = await fetch(`${APIFY_BASE}/users/me?token=${encodeURIComponent(token)}`, {
  headers: { accept: "application/json" },
});
console.log(`/users/me → HTTP ${res.status} ${res.ok ? "(token valid)" : "(token REJECTED)"}`);

if (res.ok) {
  const json = (await res.json()) as {
    data?: {
      username?: string;
      plan?: { id?: string; maxMonthlyUsageUsd?: number };
      monthlyUsage?: { usageTotalUsd?: number };
    };
  };
  const d = json.data ?? {};
  console.log(`  username: ${d.username ?? "—"}`);
  console.log(`  plan: ${d.plan?.id ?? "—"} (monthly cap ~$${d.plan?.maxMonthlyUsageUsd ?? "?"})`);
  console.log(`  month-to-date spend: $${d.monthlyUsage?.usageTotalUsd?.toFixed?.(3) ?? "?"}`);
} else {
  console.log(`  body: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}
console.log("");
