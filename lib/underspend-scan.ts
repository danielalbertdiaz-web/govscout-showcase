/**
 * Item U1 — underspend scan orchestrator.
 *
 * The impure shell that ties the pieces together: discover unspent balances
 * from the source registry, RANK them by the underspend model, then upsert the
 * top-ranked ones into `funding_pools` so they appear in the existing `/pools`
 * UI alongside the hand-curated "Underutilized Pools Master Punch List".
 *
 * Auto-discovered pools are tagged `auto-discovered` + `underspend` and carry a
 * stable `source` label so re-scans upsert (refresh numbers / rank) without
 * clobbering any pool the operator has since researched/engaged. NOTHING is
 * sent — discovery + persistence only.
 */

import { upsertDiscoveredPool, type FundingPool } from "./db";
import {
  searchUnderspendSources,
  formatMoneyShort,
  pctUnspent,
  type UnderspendRecord,
} from "./underspend-sources/index";
import {
  rankUnderspend,
  isPersistableUnderspend,
  DEFAULT_UNDERSPEND_KEYWORDS,
  EL_HOME_STATES,
  type RankedUnderspend,
} from "./underspend-scoring";

const SOURCE_LABELS: Record<string, string> = {
  usaspending: "USASpending.gov (auto)",
};

export function underspendPoolSource(sourceId: string): string {
  return SOURCE_LABELS[sourceId] ?? `${sourceId} (auto)`;
}

function jurisdictionTag(jurisdiction: string | null): string | null {
  const j = (jurisdiction ?? "").toLowerCase();
  if (j.includes("new jersey") || /\bnj\b/.test(j)) return "nj";
  if (j.includes("florida") || /\bfl\b/.test(j)) return "fl";
  if (j === "federal") return "federal";
  return null;
}

function rankedToPoolInput(
  userEmail: string,
  ranked: RankedUnderspend,
  rank: number,
): Parameters<typeof upsertDiscoveredPool>[0] {
  const r = ranked.record;
  const pct = Math.round(pctUnspent(r) * 100);
  const tags = ["auto-discovered", "underspend"];
  const jt = jurisdictionTag(r.jurisdiction);
  if (jt) tags.push(jt);

  return {
    userEmail,
    name: r.name,
    source: underspendPoolSource(r.source),
    rank,
    agency: r.agency,
    jurisdiction: r.jurisdiction,
    status: "discovered",
    playType: "RFP shaping / direct",
    allocatedAmount: r.allocated > 0 ? formatMoneyShort(r.allocated) : null,
    unspentAmount: `${formatMoneyShort(r.unspent)} (${pct}% unspent)`,
    deadlineLabel: r.periodEnd
      ? `Period of availability ends ${r.periodEnd}`
      : r.fiscalYear
        ? `FY${r.fiscalYear} unobligated balance`
        : "Unobligated balance",
    fitSummary: `Underspend score ${ranked.score}/100 — ${ranked.reasons.join(" · ")}`,
    tags,
  };
}

export type UnderspendScanResult = {
  available: boolean;
  found: number; // raw records discovered
  ranked: number; // records above threshold
  created: number;
  updated: number;
  sourcesUsed: string[];
  top: Array<{ name: string; unspent: string; score: number }>;
};

export type UnderspendScanOptions = {
  keywords?: string[];
  homeStates?: string[];
  minUnspent?: number;
  limit?: number;
  fiscalYear?: number;
  now?: number;
};

export async function runUnderspendScan(
  userEmail: string,
  opts: UnderspendScanOptions = {},
): Promise<UnderspendScanResult> {
  const keywords = opts.keywords ?? DEFAULT_UNDERSPEND_KEYWORDS;
  const homeStates = opts.homeStates ?? [...EL_HOME_STATES];
  const minUnspent = opts.minUnspent ?? 100_000; // ignore trivial balances
  const limit = opts.limit ?? 40;

  const { records, sourcesUsed } = await searchUnderspendSources({
    keywords,
    states: homeStates,
    minUnspent,
    fiscalYear: opts.fiscalYear,
    limit,
  });

  if (records.length === 0) {
    return { available: sourcesUsed.length > 0, found: 0, ranked: 0, created: 0, updated: 0, sourcesUsed, top: [] };
  }

  const ranked = rankUnderspend({
    records,
    ctx: { keywords, homeStates, now: opts.now },
    limit,
  }).filter((x) => isPersistableUnderspend(x));

  let created = 0;
  let updated = 0;
  const top: UnderspendScanResult["top"] = [];

  ranked.forEach((item, i) => {
    const { created: wasCreated } = upsertDiscoveredPool(rankedToPoolInput(userEmail, item, i + 1));
    if (wasCreated) created += 1;
    else updated += 1;
    if (i < 10) {
      top.push({
        name: item.record.name,
        unspent: formatMoneyShort(item.record.unspent),
        score: item.score,
      });
    }
  });

  return {
    available: sourcesUsed.length > 0,
    found: records.length,
    ranked: ranked.length,
    created,
    updated,
    sourcesUsed,
    top,
  };
}

export type { UnderspendRecord, FundingPool };
