/**
 * USASpending.gov adapter — FREE, no API key (the open Treasury spending API).
 *
 * Goal: surface federal accounts with large UNOBLIGATED (unspent) balances on
 * Acme's themes. Verified against the live API (2026-06): the unobligated balance
 * is NOT exposed by the Spending-Explorer (`/spending/`, which only returns a
 * single `amount`). It lives in the per-account detail, as
 *   unspent = total_budgetary_resources − total_obligated_amount.
 *
 * So this is a TWO-STEP source:
 *   1) POST /api/v2/federal_accounts/ with a keyword (matches the account name)
 *      → candidate accounts {code, name, agency, budgetary_resources}.
 *   2) GET /api/v2/federal_accounts/{code}/?fiscal_year=FY for each candidate
 *      → the obligated/outlay/resources breakdown to derive unspent.
 *
 * Split: PURE request-builders + PURE tolerant parsers (unit-tested, network
 * free) and a thin impure `search` that fans the keywords out, unions by
 * account code, then fetches balances concurrently.
 */

import {
  deriveUnspent,
  type UnderspendQuery,
  type UnderspendRecord,
  type UnderspendSource,
} from "./types";

export const USASPENDING_BASE = "https://api.usaspending.gov/api/v2";
export const FEDERAL_ACCOUNTS_ENDPOINT = `${USASPENDING_BASE}/federal_accounts/`;

const SOURCE_ID = "usaspending";

// ---- Pure: fiscal year -----------------------------------------------------

export function currentFederalFiscalYear(now = new Date()): number {
  // US federal FY starts Oct 1; Oct–Dec belong to the next FY.
  const m = now.getUTCMonth(); // 0-based
  const y = now.getUTCFullYear();
  return m >= 9 ? y + 1 : y;
}

// ---- Pure: request builders ------------------------------------------------

/** Step 1: the federal-accounts LIST request (keyword search by account name). */
export function buildFederalAccountsListRequest(query: {
  keyword: string;
  fiscalYear?: number;
  limit?: number;
}): { url: string; body: Record<string, unknown> } {
  const fy = query.fiscalYear ?? currentFederalFiscalYear();
  return {
    url: FEDERAL_ACCOUNTS_ENDPOINT,
    body: {
      sort: { field: "budgetary_resources", direction: "desc" },
      limit: query.limit ?? 10,
      page: 1,
      keyword: query.keyword,
      filters: { fy: String(fy) },
    },
  };
}

/** Step 2: the per-account DETAIL url (carries the obligated/resources split). */
export function federalAccountDetailUrl(code: string, fiscalYear: number): string {
  return `${FEDERAL_ACCOUNTS_ENDPOINT}${encodeURIComponent(code)}/?fiscal_year=${fiscalYear}`;
}

/** Public-facing USASpending page for an account (used as the record url). */
export function federalAccountPageUrl(code: string): string {
  return `https://www.usaspending.gov/federal_account/${code}`;
}

// ---- Pure: parsers ---------------------------------------------------------

export type AccountStub = {
  code: string;
  name: string;
  agency: string | null;
  budgetaryResources: number;
};

type ListRow = {
  account_number?: string;
  account_name?: string;
  managing_agency?: string;
  managing_agency_acronym?: string;
  budgetary_resources?: number;
};

type DetailBody = {
  federal_account_code?: string;
  account_title?: string;
  parent_agency_name?: string;
  bureau_name?: string;
  total_obligated_amount?: number;
  total_gross_outlay_amount?: number;
  total_budgetary_resources?: number;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parse the LIST response into account stubs. Never throws; [] on junk. */
export function parseFederalAccountsList(body: unknown): AccountStub[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const out: AccountStub[] = [];
  for (const raw of results as ListRow[]) {
    const code = (raw.account_number ?? "").trim();
    const name = (raw.account_name ?? "").trim();
    if (!code || !name) continue;
    out.push({
      code,
      name,
      agency: raw.managing_agency ?? raw.managing_agency_acronym ?? null,
      budgetaryResources: num(raw.budgetary_resources),
    });
  }
  return out;
}

/**
 * Parse the per-account DETAIL response into an UnderspendRecord.
 * unspent = budgetary_resources − obligated (the unobligated balance).
 * Returns null for junk or a non-positive unspent (nothing left to chase).
 */
export function parseFederalAccountDetail(
  body: unknown,
  fiscalYear: number,
  fallback?: Partial<AccountStub>,
): UnderspendRecord | null {
  if (!body || typeof body !== "object") return null;
  const d = body as DetailBody;

  const code = (d.federal_account_code ?? fallback?.code ?? "").trim();
  const name = (d.account_title ?? fallback?.name ?? "").trim();
  if (!code || !name) return null;

  const allocated = num(d.total_budgetary_resources) || num(fallback?.budgetaryResources);
  const obligated = num(d.total_obligated_amount);
  const unspent = deriveUnspent({ allocated, spent: obligated });
  if (unspent <= 0) return null;

  return {
    recordId: `usa:${fiscalYear}:${code}`,
    name,
    agency: d.parent_agency_name ?? fallback?.agency ?? null,
    jurisdiction: "Federal",
    program: d.bureau_name ?? name,
    allocated: allocated || unspent,
    spent: obligated,
    unspent,
    fiscalYear,
    periodEnd: null,
    url: federalAccountPageUrl(code),
    source: SOURCE_ID,
  };
}

// ---- Impure: live source ---------------------------------------------------

async function postJson(url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) return null;
  return res.json();
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) return null;
  return res.json();
}

export const usaspendingSource: UnderspendSource = {
  id: SOURCE_ID,
  label: "USASpending.gov federal-account balances",
  // Free open API — always available (no key). Network failure is handled below.
  get available() {
    return true;
  },
  async search(query: UnderspendQuery): Promise<UnderspendRecord[]> {
    const fy = query.fiscalYear ?? currentFederalFiscalYear();
    const keywords = (query.keywords ?? []).filter((k) => k.trim().length > 0);
    if (keywords.length === 0) return [];

    const perKeyword = Math.max(4, Math.ceil((query.limit ?? 40) / 4));
    const maxAccounts = Math.min(60, (query.limit ?? 40) + 10);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      // Step 1: fan keywords out, union candidate accounts by code (keep the
      // biggest budgetary_resources seen for each).
      const stubs = new Map<string, AccountStub>();
      const lists = await Promise.allSettled(
        keywords.map((keyword) => {
          const { url, body } = buildFederalAccountsListRequest({
            keyword,
            fiscalYear: fy,
            limit: perKeyword,
          });
          return postJson(url, body, ctrl.signal).then(parseFederalAccountsList);
        }),
      );
      for (const r of lists) {
        if (r.status !== "fulfilled") continue;
        for (const s of r.value) {
          const prev = stubs.get(s.code);
          if (!prev || s.budgetaryResources > prev.budgetaryResources) stubs.set(s.code, s);
        }
      }

      // Rank candidates by gross size before spending the detail-fetch budget.
      const candidates = [...stubs.values()]
        .sort((a, b) => b.budgetaryResources - a.budgetaryResources)
        .slice(0, maxAccounts);

      // Step 2: fetch each account's balance detail concurrently.
      const details = await Promise.allSettled(
        candidates.map((stub) =>
          getJson(federalAccountDetailUrl(stub.code, fy), ctrl.signal).then((body) =>
            parseFederalAccountDetail(body, fy, stub),
          ),
        ),
      );

      const records: UnderspendRecord[] = [];
      for (const r of details) {
        if (r.status === "fulfilled" && r.value) records.push(r.value);
      }
      return records;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  },
};
