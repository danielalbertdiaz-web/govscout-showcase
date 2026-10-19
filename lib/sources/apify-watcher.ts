/**
 * Sprint 8 — Apify source orchestrator (foundations + lead portals).
 *
 * Two source families share this orchestrator:
 *
 *   - `foundation`: 6 named foundations (RWJF, Hilton, Kresge, Bloomberg
 *     overdose, NJHI, Schultz). One Apify run per family with all 6 URLs
 *     passed as startUrls.
 *   - `lead_portal`: 5 state lead-poisoning portals (NJ DCF LRAP, NJ DOH
 *     Childhood Lead, NJ DHS RFPs, FL DOH Childhood Lead, FL DEP lead).
 *     Same shape.
 *
 * The brief said "single Apify actor batched across N URLs." We use
 * `apify/website-content-crawler` (free actor on the marketplace) and
 * post-process the dataset into `scout_items` via a per-source parser
 * keyed off the URL host. The crawler returns Markdown + structured
 * metadata which is perfectly serviceable for grant-listing pages.
 *
 * Dedup is by canonical URL against `scout_items.url` — we never insert
 * a row whose URL already exists for this user.
 *
 * Per Sprint 7: items get the standard fit-scoring on the next
 * `score-batch` run, and any item promoted to a saved_opportunity that
 * scores ≥ 80 will auto-fire `tryAutoDraft`. No special wiring needed
 * here.
 */

import { randomUUID } from "crypto";
import { getDb } from "../db";
import { tryLogActivity } from "../activity";
import { runApifyActor, APIFY_BUDGET_PER_RUN_USD, type ApifyRunResult } from "../apify";
import { createSuggestion, listSuggestions } from "../suggestions";
import type { ScoutSource } from "../scouts-types";
import {
  orderedBoards,
  settlementNotes,
  type SettlementBoard,
} from "../settlement-boards/catalogue";

// ---------- Source catalogues ---------------------------------------------

export type WatchTarget = {
  sourceId: string;            // stable slug, used as paneContextId and dedup key
  label: string;               // human display
  url: string;                 // landing page to crawl
  source: ScoutSource;         // enum bucket for /scouts pane
  titleSelector?: string;      // optional CSS for the actor's link-extraction
  notes?: string | null;       // structured marker carried into scout_items.notes
                               // (e.g. funding_source:opioid_settlement for 5.3)
};

export const FOUNDATION_TARGETS: WatchTarget[] = [
  {
    sourceId: "rwjf",
    label: "Robert Wood Johnson Foundation",
    url: "https://www.rwjf.org/en/grants/funding-opportunities.html",
    source: "foundation",
  },
  {
    sourceId: "hilton",
    label: "Conrad N. Hilton Foundation",
    url: "https://www.hiltonfoundation.org/our-funding",
    source: "foundation",
  },
  {
    sourceId: "kresge",
    label: "The Kresge Foundation",
    url: "https://kresge.org/grants-social-investments/current-funding-opportunities/",
    source: "foundation",
  },
  {
    sourceId: "bloomberg_overdose",
    label: "Bloomberg Philanthropies — Overdose Prevention",
    url: "https://www.bloomberg.org/public-health/preventing-overdoses/",
    source: "foundation",
  },
  {
    sourceId: "njhi",
    label: "New Jersey Health Initiatives",
    url: "https://www.njhi.org/grant-opportunities/",
    source: "foundation",
  },
  {
    sourceId: "schultz",
    label: "Schultz Family Foundation",
    url: "https://www.schultzfamilyfoundation.org/our-work/",
    source: "foundation",
  },
];

export const LEAD_PORTAL_TARGETS: WatchTarget[] = [
  {
    sourceId: "nj_dcf_lrap",
    label: "NJ DCA Lead Remediation & Abatement Program",
    url: "https://www.nj.gov/dca/dhcr/offices/lrap.shtml",
    source: "lead_portal",
  },
  {
    sourceId: "nj_doh_lead",
    label: "NJ DOH Childhood Lead Poisoning Prevention",
    url: "https://www.nj.gov/health/childhoodlead/",
    source: "lead_portal",
  },
  {
    sourceId: "nj_dhs_rfp",
    label: "NJ DHS RFP / RFI Portal",
    url: "https://www.nj.gov/humanservices/providers/grants/rfprfi/",
    source: "lead_portal",
  },
  {
    sourceId: "fl_doh_lead",
    label: "Florida DOH Childhood Lead Poisoning Prevention",
    url: "https://www.floridahealth.gov/diseases-and-conditions/lead-poisoning/",
    source: "lead_portal",
  },
  {
    sourceId: "fl_dep_lead",
    label: "Florida DEP Lead Programs",
    url: "https://floridadep.gov/waste/permitting-compliance-assistance/content/lead-based-paint",
    source: "lead_portal",
  },
];

export type WatcherFamily = "foundation" | "lead_portal" | "settlement";

// Item 5.3 — opioid-settlement boards become WatchTargets straight from the
// curated catalogue, home-state-biased (NJ→FL→rest) so they crawl first. Each
// carries the funding_source:opioid_settlement marker into scout_items.notes.
export function boardToWatchTarget(board: SettlementBoard): WatchTarget {
  return {
    sourceId: `settlement_${board.id}`,
    label: board.name,
    url: board.dashboardUrl,
    source: board.level === "county" ? "county" : "state",
    notes: settlementNotes(board),
  };
}

export function settlementTargets(): WatchTarget[] {
  return orderedBoards().map(boardToWatchTarget);
}

export function targetsFor(family: WatcherFamily): WatchTarget[] {
  switch (family) {
    case "foundation":
      return FOUNDATION_TARGETS;
    case "lead_portal":
      return LEAD_PORTAL_TARGETS;
    case "settlement":
      return settlementTargets();
  }
}

export function familyLabel(family: WatcherFamily): string {
  switch (family) {
    case "foundation":
      return `Foundation Watcher (${FOUNDATION_TARGETS.length} sources)`;
    case "lead_portal":
      return `Lead-Portal Watcher (${LEAD_PORTAL_TARGETS.length} sources)`;
    case "settlement":
      return `Opioid-Settlement Watcher (${settlementTargets().length} boards)`;
  }
}

// ---------- Apify item shape ----------------------------------------------

// website-content-crawler dataset row shape (the subset we care about).
// See https://apify.com/apify/website-content-crawler#output. Other actors
// can be plugged in by adapting toScoutItem().
type WebContentCrawlerItem = {
  url?: string;
  loadedUrl?: string;
  title?: string;
  text?: string;
  markdown?: string;
  metadata?: { description?: string; canonicalUrl?: string; title?: string };
  screenshotUrl?: string;
  crawl?: { httpStatusCode?: number; loadedTime?: string };
};

// ---------- Ingest path ---------------------------------------------------

export type WatcherRunResult = {
  family: WatcherFamily;
  ok: boolean;
  digestId: string | null;
  newItems: number;
  skippedDedup: number;
  blockedTargets: string[];
  costUsd: number;
  durationMs: number;
  apifyStatus: ApifyRunResult["status"];
  error: string | null;
};

export type RunWatcherOptions = {
  userEmail: string;
  family: WatcherFamily;
  // Testing hook — bypass the live Apify call and supply fixture items.
  dryRunItems?: WebContentCrawlerItem[];
  signal?: AbortSignal;
};

function existingUrlIsDuplicate(userEmail: string, url: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS x FROM scout_items WHERE user_email = ? AND url = ? LIMIT 1`,
    )
    .get(userEmail, url) as { x: number } | undefined;
  return Boolean(row);
}

// Per-target Suggestion Inbox dedup: only file a "needs human review"
// suggestion if there isn't an open one for the same sourceId.
function maybeFileNeedsHumanReview(input: {
  userEmail: string;
  sourceId: string;
  label: string;
  url: string;
}): void {
  const open = listSuggestions({
    userEmail: input.userEmail,
    status: "open",
    paneContextType: "apify_needs_human_review",
    paneContextId: input.sourceId,
  });
  if (open.length > 0) return;
  try {
    createSuggestion({
      userEmail: input.userEmail,
      paneContextType: "apify_needs_human_review",
      paneContextId: input.sourceId,
      body: `Apify scrape blocked for "${input.label}" (${input.url}). Likely Cloudflare/captcha — open in a browser and capture the listings manually, or swap to a per-site actor.`,
    });
  } catch {
    // non-critical
  }
  tryLogActivity({
    actor: input.userEmail,
    actionType: "apify_needs_human_review",
    targetType: "apify",
    targetId: input.sourceId,
    summary: `Needs human review: ${input.label} (${input.url})`,
  });
}

function canonicalize(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // strip trailing slash + utm params for stable dedup
    u.hash = "";
    [...u.searchParams.keys()]
      .filter((k) => k.toLowerCase().startsWith("utm_"))
      .forEach((k) => u.searchParams.delete(k));
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url.trim();
  }
}

// Match each crawler item back to its WatchTarget by host containment.
// startUrl matching is more precise but the crawler sometimes rewrites
// the final URL (redirects); host containment is the pragmatic fallback.
function matchTarget(item: WebContentCrawlerItem, targets: WatchTarget[]): WatchTarget | null {
  const itemUrl = item.loadedUrl ?? item.url ?? item.metadata?.canonicalUrl;
  if (!itemUrl) return targets[0] ?? null;
  let host = "";
  try {
    host = new URL(itemUrl).host.toLowerCase();
  } catch {
    return targets[0] ?? null;
  }
  for (const t of targets) {
    try {
      const targetHost = new URL(t.url).host.toLowerCase();
      if (host === targetHost || host.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${host}`)) {
        return t;
      }
    } catch {
      // ignore malformed
    }
  }
  return null;
}

function toScoutItemFields(item: WebContentCrawlerItem, target: WatchTarget): {
  title: string;
  url: string | null;
  rawText: string;
  source: ScoutSource;
  agency: string | null;
  notes: string | null;
} {
  const title = (item.title ?? item.metadata?.title ?? target.label).slice(0, 240);
  const url = canonicalize(item.loadedUrl ?? item.url ?? item.metadata?.canonicalUrl ?? target.url);
  const rawText =
    (item.markdown ?? item.text ?? item.metadata?.description ?? "")
      .trim()
      .slice(0, 8000) ||
    `(no content extracted for ${target.label})`;
  return {
    title,
    url,
    rawText,
    source: target.source,
    agency: target.label,
    notes: target.notes ?? null,
  };
}

// Persist the run as a synthetic scout_digest + scout_items, mirroring the
// shape the cron-based ingest path produces. Cron jobs use real UUIDs for
// the job id; for Apify we use a stable `apify:foundation` / `apify:lead_portal`
// pseudo-id so the UI can filter on it the same way.
function persistDigest(input: {
  userEmail: string;
  family: WatcherFamily;
  runId: string | null;
  costUsd: number;
  durationMs: number;
  itemSummary: string;
}): string {
  const digestId = randomUUID();
  const cronJobId = `apify:${input.family}`;
  const stmt = getDb().prepare(
    `INSERT INTO scout_digests (
       id, user_email, cron_job_id, cron_session_id, source_label,
       ran_at_ms, status, summary, model, duration_ms, ingested_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The (cron_job_id, ran_at_ms) UNIQUE constraint exists to dedupe
  // cron re-runs at the same wall-clock millisecond. Two Apify runs
  // can legitimately fire in the same ms (test loops, fast retries) —
  // bump ran_at_ms forward until we land in an empty slot. Bounded
  // retry of 25 (~25ms) is plenty for any realistic burst.
  let ranAtMs = Date.now();
  const now = ranAtMs;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      stmt.run(
        digestId,
        input.userEmail,
        cronJobId,
        input.runId,
        `Apify ${familyLabel(input.family)}`,
        ranAtMs,
        "ok",
        input.itemSummary,
        "apify/website-content-crawler",
        input.durationMs,
        now,
      );
      return digestId;
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        ranAtMs += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`scout_digests insert collided 25× — abort`);
}

function insertScoutItem(input: {
  id: string;
  digestId: string;
  userEmail: string;
  source: ScoutSource;
  title: string;
  agency: string | null;
  url: string | null;
  rawText: string;
  notes?: string | null;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO scout_items (
         id, digest_id, user_email, source, title, agency, deadline_text,
         funding_text, naics, url, raw_text, status, pool_id,
         saved_opportunity_id, notes, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.digestId,
      input.userEmail,
      input.source,
      input.title,
      input.agency,
      null,
      null,
      null,
      input.url,
      input.rawText,
      "new",
      null,
      null,
      input.notes ?? null,
      now,
      now,
    );
}

// Public entry point — one HTTP call to /api/scouts/apify-run routes here.
export async function runWatcher(opts: RunWatcherOptions): Promise<WatcherRunResult> {
  const targets = targetsFor(opts.family);
  const startedAt = Date.now();

  let apifyResult: ApifyRunResult<WebContentCrawlerItem>;
  if (opts.dryRunItems) {
    apifyResult = {
      ok: true,
      status: "completed",
      items: opts.dryRunItems,
      runId: "dryrun",
      computeUnits: 0,
      costUsd: 0,
      durationMs: 0,
      error: null,
      needsHumanReview: false,
    };
    tryLogActivity({
      actor: opts.userEmail,
      actionType: "apify_run",
      targetType: "apify",
      targetId: `dryrun:${opts.family}`,
      summary: `Apify dryrun "${opts.family}" → ${opts.dryRunItems.length} items (no API call).`,
    });
  } else {
    apifyResult = await runApifyActor<WebContentCrawlerItem>({
      actorId: "apify/website-content-crawler",
      label: familyLabel(opts.family),
      userEmail: opts.userEmail,
      signal: opts.signal,
      input: {
        startUrls: targets.map((t) => ({ url: t.url })),
        maxCrawlPages: 25,
        maxCrawlDepth: 1,
        crawlerType: "playwright:firefox",
        saveMarkdown: true,
        saveScreenshots: false,
        proxyConfiguration: { useApifyProxy: true },
      },
    });
  }

  if (!apifyResult.ok && apifyResult.status !== "needs_human_review") {
    return {
      family: opts.family,
      ok: false,
      digestId: null,
      newItems: 0,
      skippedDedup: 0,
      blockedTargets: [],
      costUsd: apifyResult.costUsd,
      durationMs: Date.now() - startedAt,
      apifyStatus: apifyResult.status,
      error: apifyResult.error,
    };
  }

  // Per-target blocked-output detection: if a per-target subset of items
  // looks like Cloudflare boilerplate, file a Suggestion Inbox entry for
  // THAT source while still ingesting the unblocked ones.
  const blockedTargets: string[] = [];
  const matchedByTarget = new Map<string, WebContentCrawlerItem[]>();
  for (const it of apifyResult.items) {
    const t = matchTarget(it, targets);
    if (!t) continue;
    const arr = matchedByTarget.get(t.sourceId) ?? [];
    arr.push(it);
    matchedByTarget.set(t.sourceId, arr);
  }
  for (const t of targets) {
    const subset = matchedByTarget.get(t.sourceId) ?? [];
    if (subset.length === 0) continue;
    const blockedFraction =
      subset.filter((i) => {
        const blob = JSON.stringify(i).toLowerCase();
        return /cloudflare|captcha|verify you are human|just a moment/.test(blob);
      }).length / subset.length;
    if (blockedFraction >= 0.5) {
      blockedTargets.push(t.sourceId);
      maybeFileNeedsHumanReview({
        userEmail: opts.userEmail,
        sourceId: t.sourceId,
        label: t.label,
        url: t.url,
      });
    }
  }

  // De-dup by URL, persist into scout_items.
  let newItems = 0;
  let skippedDedup = 0;
  const digestId = persistDigest({
    userEmail: opts.userEmail,
    family: opts.family,
    runId: apifyResult.runId,
    costUsd: apifyResult.costUsd,
    durationMs: apifyResult.durationMs,
    itemSummary: `Apify ${opts.family} run @ ${new Date(startedAt).toISOString()} — ${apifyResult.items.length} raw items, ${blockedTargets.length} blocked sources.`,
  });

  for (const item of apifyResult.items) {
    const target = matchTarget(item, targets);
    if (!target) continue;
    if (blockedTargets.includes(target.sourceId)) continue;
    const fields = toScoutItemFields(item, target);
    if (fields.url && existingUrlIsDuplicate(opts.userEmail, fields.url)) {
      skippedDedup += 1;
      continue;
    }
    insertScoutItem({
      id: randomUUID(),
      digestId,
      userEmail: opts.userEmail,
      source: fields.source,
      title: fields.title,
      agency: fields.agency,
      url: fields.url,
      rawText: fields.rawText,
      notes: fields.notes,
    });
    newItems += 1;
  }

  return {
    family: opts.family,
    ok: true,
    digestId,
    newItems,
    skippedDedup,
    blockedTargets,
    costUsd: apifyResult.costUsd,
    durationMs: Date.now() - startedAt,
    apifyStatus: apifyResult.status,
    error: null,
  };
}

export const _internals = {
  canonicalize,
  matchTarget,
  toScoutItemFields,
  detectBlockedFraction(items: WebContentCrawlerItem[]): number {
    if (items.length === 0) return 0;
    return (
      items.filter((i) => /cloudflare|captcha/.test(JSON.stringify(i).toLowerCase())).length /
      items.length
    );
  },
  budgetCapUsd: APIFY_BUDGET_PER_RUN_USD,
};
