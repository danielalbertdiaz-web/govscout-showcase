/**
 * Sprint 8 smoke test — exercises the Apify watcher ingest path WITHOUT
 * hitting Apify (dryRunItems bypass). Costs zero credit.
 *
 * Verifies:
 *   1. New scout_items inserted with source='foundation' / 'lead_portal'
 *   2. Dedup-by-URL: re-ingesting the same item returns skippedDedup>0
 *   3. Cloudflare-blocked items per-target → Suggestion Inbox entry +
 *      activity_log apify_needs_human_review, and the un-blocked items
 *      from OTHER targets still land in scout_items
 *   4. Suggestion dedup: re-running the blocked path does NOT spawn a
 *      second open suggestion for the same source_id
 *   5. URL canonicalisation strips utm_* params and trailing slash
 *   6. The scout_source enum includes 'lead_portal'
 *   7. Apify token guard rejects cleanly when env missing
 */

import { getDb } from "../lib/db";
import { runWatcher, _internals } from "../lib/sources/apify-watcher";
import { listSuggestions } from "../lib/suggestions";
import { listRecentActivity } from "../lib/activity";
import { isScoutSource } from "../lib/scouts-types";
import { getApifyToken } from "../lib/apify";

const TEST_USER = `sprint8-smoke+${Date.now()}@acmeconsulting.test`;

function bar(s: string): void {
  process.stdout.write(`\n=== ${s} ===\n`);
}
function ok(label: string, cond: boolean, extra?: string): void {
  const tag = cond ? "PASS" : "FAIL";
  process.stdout.write(`  [${tag}] ${label}${extra ? ` — ${extra}` : ""}\n`);
  if (!cond) process.exitCode = 1;
}

function countScoutItems(userEmail: string, source: string): number {
  const r = getDb()
    .prepare(`SELECT COUNT(*) as n FROM scout_items WHERE user_email = ? AND source = ?`)
    .get(userEmail, source) as { n: number };
  return Number(r?.n ?? 0);
}

async function main(): Promise<void> {
  getDb();
  bar("Sprint 8 — Apify watcher smoke");
  process.stdout.write(`User: ${TEST_USER}\n`);
  process.stdout.write(`APIFY_TOKEN present in env: ${getApifyToken() ? "yes" : "NO"}\n`);

  // ---- T1: enum + canonicalize sanity ----
  bar("T1 — enum + URL canonicalisation");
  ok("'lead_portal' in SCOUT_SOURCES", isScoutSource("lead_portal"));
  ok("'foundation' in SCOUT_SOURCES", isScoutSource("foundation"));
  const c1 = _internals.canonicalize("https://www.rwjf.org/grants/?utm_source=x&utm_campaign=y&id=42");
  ok("canonicalize strips utm_* and keeps id", c1 === "https://www.rwjf.org/grants/?id=42", `got=${c1}`);
  const c2 = _internals.canonicalize("https://www.rwjf.org/grants/");
  ok("canonicalize trims trailing slash", c2 === "https://www.rwjf.org/grants", `got=${c2}`);

  // ---- T2: dry-run foundation ingest ----
  bar("T2 — foundation dry-run ingests 2 new items");
  const fixture1 = [
    {
      loadedUrl: "https://www.rwjf.org/en/grants/funding-opportunities/community-resilience-2026.html",
      url: "https://www.rwjf.org/en/grants/funding-opportunities/community-resilience-2026.html",
      title: "Community Resilience 2026 — Open RFP",
      markdown: "RWJF invites applications for community resilience projects. Deadline March 2027.",
      metadata: { canonicalUrl: "https://www.rwjf.org/en/grants/funding-opportunities/community-resilience-2026.html" },
    },
    {
      loadedUrl: "https://www.njhi.org/grant-opportunities/healthy-aging-2026.html",
      url: "https://www.njhi.org/grant-opportunities/healthy-aging-2026.html",
      title: "Healthy Aging Initiative 2026",
      markdown: "NJ Health Initiatives funds projects supporting healthy aging across NJ counties.",
    },
  ];
  const r1 = await runWatcher({
    userEmail: TEST_USER,
    family: "foundation",
    dryRunItems: fixture1,
  });
  ok("ok=true", r1.ok, `status=${r1.apifyStatus}`);
  ok("newItems=2", r1.newItems === 2, `got=${r1.newItems}`);
  ok("skippedDedup=0", r1.skippedDedup === 0);
  ok("foundation rows persisted", countScoutItems(TEST_USER, "foundation") === 2);

  // ---- T3: dedup on second run with same URLs ----
  bar("T3 — re-running same fixture dedups all items");
  const r2 = await runWatcher({
    userEmail: TEST_USER,
    family: "foundation",
    dryRunItems: fixture1,
  });
  ok("newItems=0", r2.newItems === 0, `got=${r2.newItems}`);
  ok("skippedDedup=2", r2.skippedDedup === 2, `got=${r2.skippedDedup}`);
  ok("scout_items still 2", countScoutItems(TEST_USER, "foundation") === 2);

  // ---- T4: cloudflare-blocked target → suggestion inbox + un-blocked items still ingested ----
  bar("T4 — per-target Cloudflare block routes one source to Suggestion Inbox");
  const fixture2 = [
    {
      loadedUrl: "https://www.hiltonfoundation.org/our-funding/early-childhood-2026.html",
      title: "Early Childhood Initiative 2026",
      markdown: "The Hilton Foundation seeks proposals for early childhood programs.",
    },
    // Three blocked items for kresge — majority of the kresge subset
    {
      loadedUrl: "https://kresge.org/grants/blocked-1",
      title: "Just a moment...",
      markdown: "Just a moment... please verify you are human. Cloudflare Ray ID: abc123.",
    },
    {
      loadedUrl: "https://kresge.org/grants/blocked-2",
      title: "Attention Required",
      markdown: "Checking your browser before accessing kresge.org. Cloudflare protection.",
    },
  ];
  const r3 = await runWatcher({
    userEmail: TEST_USER,
    family: "foundation",
    dryRunItems: fixture2,
  });
  ok("ok=true (un-blocked items ingested)", r3.ok);
  ok("blockedTargets includes 'kresge'", r3.blockedTargets.includes("kresge"), `actual=${JSON.stringify(r3.blockedTargets)}`);
  ok("newItems=1 (only hilton)", r3.newItems === 1, `got=${r3.newItems}`);
  const sug = listSuggestions({
    userEmail: TEST_USER,
    status: "open",
    paneContextType: "apify_needs_human_review",
    paneContextId: "kresge",
  });
  ok("kresge Suggestion Inbox entry filed", sug.length === 1, `got=${sug.length}`);
  const acts = listRecentActivity({ actionTypes: ["apify_needs_human_review"], limit: 5 });
  const kresgeAct = acts.find((a) => a.targetId === "kresge");
  ok("apify_needs_human_review activity logged for kresge", !!kresgeAct);

  // ---- T5: re-running blocked path doesn't dupe the suggestion ----
  bar("T5 — Suggestion Inbox dedup per source");
  await runWatcher({
    userEmail: TEST_USER,
    family: "foundation",
    dryRunItems: fixture2,
  });
  const sugAfter = listSuggestions({
    userEmail: TEST_USER,
    status: "open",
    paneContextType: "apify_needs_human_review",
    paneContextId: "kresge",
  });
  ok("kresge suggestion still 1 (not 2)", sugAfter.length === 1, `got=${sugAfter.length}`);

  // ---- T6: lead_portal dry-run ingest ----
  bar("T6 — lead_portal dry-run ingests 1 new item");
  const fixture3 = [
    {
      loadedUrl: "https://www.nj.gov/dca/dhcr/offices/lrap.shtml/funding-cycle-2026",
      title: "NJ LRAP Funding Cycle 2026",
      markdown: "NJ DCA Lead Remediation & Abatement Program is accepting applications.",
    },
  ];
  const r4 = await runWatcher({
    userEmail: TEST_USER,
    family: "lead_portal",
    dryRunItems: fixture3,
  });
  ok("ok=true", r4.ok);
  ok("newItems=1", r4.newItems === 1);
  ok("lead_portal row persisted", countScoutItems(TEST_USER, "lead_portal") === 1);

  // ---- T7: missing-token guard ----
  bar("T7 — APIFY_TOKEN guard (simulated by removing token)");
  const original = process.env.APIFY_TOKEN;
  delete process.env.APIFY_TOKEN;
  try {
    const r5 = await runWatcher({
      userEmail: TEST_USER,
      family: "foundation",
      // No dryRunItems → goes through real apify path
    });
    ok("missing token → ok=false", r5.ok === false, `actual ok=${r5.ok}`);
    ok("status=missing_token", r5.apifyStatus === "missing_token", `actual=${r5.apifyStatus}`);
  } finally {
    if (original !== undefined) process.env.APIFY_TOKEN = original;
  }

  // ---- summary ----
  bar("Final counts");
  process.stdout.write(`  foundation items:  ${countScoutItems(TEST_USER, "foundation")}\n`);
  process.stdout.write(`  lead_portal items: ${countScoutItems(TEST_USER, "lead_portal")}\n`);
  process.stdout.write(`\nExit code: ${process.exitCode ?? 0}\n`);
}

main().catch((err) => {
  process.stderr.write(`smoke failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 2;
});
