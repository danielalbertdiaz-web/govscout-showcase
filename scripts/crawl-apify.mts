/**
 * One-off END-TO-END Apify run (needs APIFY_TOKEN). Operator-authorized,
 * cost-incurring — but cost-minimized.
 * Run: node --import tsx --env-file=.env.local scripts/crawl-apify.mts
 *
 * Exercises the FULL runApifyActor path the discovery lane uses (dispatch →
 * run-sync-get-dataset-items → parse dataset → run-meta cost lookup → budget
 * guard), but with the cheapest possible config: the HTTP-only `cheerio`
 * crawler, a single trivial page, and no Apify proxy. Proves the lane works
 * without spending meaningful free-tier compute.
 */

import { runApifyActor } from "../lib/apify";

console.log(`\n=== Apify END-TO-END crawl (cost-minimized) ===`);

const result = await runApifyActor<{ url?: string; text?: string; markdown?: string }>({
  actorId: "apify/website-content-crawler",
  label: "back-test single-page crawl",
  userEmail: "owner@example.org",
  timeoutMs: 120_000,
  input: {
    startUrls: [{ url: "https://example.com" }],
    maxCrawlPages: 1,
    maxCrawlDepth: 0,
    crawlerType: "cheerio", // HTTP-only — far cheaper than a headless browser
    saveMarkdown: true,
    saveScreenshots: false,
    proxyConfiguration: { useApifyProxy: false },
  },
});

console.log(`status: ${result.status} | ok: ${result.ok}`);
console.log(`items: ${result.items.length} | runId: ${result.runId ?? "—"}`);
console.log(`computeUnits: ${result.computeUnits.toFixed(4)} | costUsd: $${result.costUsd.toFixed(4)}`);
console.log(`duration: ${(result.durationMs / 1000).toFixed(1)}s | needsHumanReview: ${result.needsHumanReview}`);
if (result.error) console.log(`error: ${result.error}`);

const first = result.items[0];
if (first) {
  const snippet = (first.text ?? first.markdown ?? "").replace(/\s+/g, " ").slice(0, 160);
  console.log(`\nfirst item url: ${first.url ?? "—"}`);
  console.log(`first item text: ${snippet}…`);
}
console.log("");
