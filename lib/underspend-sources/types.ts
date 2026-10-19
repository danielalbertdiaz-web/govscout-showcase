/**
 * Underspend discovery — shared pure types + money helpers.
 *
 * "Unallocated / underutilized funding": pools of money that have been
 * appropriated or obligated but not yet spent (outlayed) — the use-it-or-lose-it
 * balances that make the best targets for a shop that shapes RFPs. This module
 * is the network-free contract; adapters (USASpending, …) implement
 * `UnderspendSource`, the scorer ranks `UnderspendRecord`s, and the scan
 * orchestrator turns the top ones into `/pools` rows.
 *
 * Client-safe: no fs / db / network imports here.
 */

export type UnderspendRecord = {
  /** stable per-source dedup key */
  recordId: string;
  /** program / federal-account / fund name */
  name: string;
  agency: string | null;
  /** "Federal", "New Jersey", "Harbor County, NJ", … — drives geography bias */
  jurisdiction: string | null;
  program: string | null;
  /** budget authority / total obligated ceiling, USD */
  allocated: number;
  /** outlayed / disbursed to date, USD */
  spent: number;
  /** unobligated / unspent balance, USD (>= 0) */
  unspent: number;
  fiscalYear: number | null;
  /** ISO date when the funds lapse / period of availability ends, if known */
  periodEnd: string | null;
  url: string | null;
  /** source id label (e.g. "usaspending") */
  source: string;
};

export type UnderspendQuery = {
  /** theme keywords to bias/filter toward (SUD/BH/recovery/…) */
  keywords?: string[];
  /** 2-letter state codes to bias toward (home turf NJ/FL) */
  states?: string[];
  /** drop records with less unspent than this (USD) */
  minUnspent?: number;
  fiscalYear?: number;
  limit?: number;
};

export interface UnderspendSource {
  id: string;
  label: string;
  /** false when the source needs config it doesn't have (dark seam) */
  readonly available: boolean;
  search(query: UnderspendQuery): Promise<UnderspendRecord[]>;
}

// ---- Money helpers (pure) --------------------------------------------------

/** Parse "$1.18M", "$11.6M", "1,190,000", "$450K", 1190000 → number (USD). */
export function parseMoney(raw: string | number | null | undefined): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const s = raw.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return 0;
  const m = s.match(/^(-?\d*\.?\d+)\s*([kmbt])?/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult =
    m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : m[2] === "t" ? 1e12 : 1;
  return n * mult;
}

/** Format a USD number compactly: 1190000 → "$1.19M", 450000 → "$450K". */
export function formatMoneyShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** Fraction of allocated dollars left unspent, clamped to [0,1]. */
export function pctUnspent(record: Pick<UnderspendRecord, "allocated" | "unspent">): number {
  if (record.allocated <= 0) return record.unspent > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, record.unspent / record.allocated));
}

/** Derive the unspent balance defensively from allocated/spent/explicit. */
export function deriveUnspent(input: {
  allocated: number;
  spent: number;
  explicitUnspent?: number | null;
}): number {
  if (input.explicitUnspent != null && Number.isFinite(input.explicitUnspent)) {
    return Math.max(0, input.explicitUnspent);
  }
  return Math.max(0, input.allocated - input.spent);
}
