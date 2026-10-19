import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  parseMoney,
  formatMoneyShort,
  pctUnspent,
  deriveUnspent,
  type UnderspendRecord,
} from "../lib/underspend-sources/types";
import {
  buildFederalAccountsListRequest,
  federalAccountDetailUrl,
  currentFederalFiscalYear,
  parseFederalAccountsList,
  parseFederalAccountDetail,
} from "../lib/underspend-sources/usaspending";
import { underspendKey } from "../lib/underspend-sources/index";
import {
  scoreUnderspend,
  rankUnderspend,
  isPersistableUnderspend,
  UNDERSPEND_WEIGHTS,
  UNDERSPEND_THRESHOLD,
  DEFAULT_UNDERSPEND_KEYWORDS,
  EL_HOME_STATES,
  type UnderspendContext,
} from "../lib/underspend-scoring";
import { underspendPoolSource } from "../lib/underspend-scan";

const CTX: UnderspendContext = {
  keywords: DEFAULT_UNDERSPEND_KEYWORDS,
  homeStates: [...EL_HOME_STATES],
  now: Date.parse("2026-06-05T00:00:00Z"),
};

function rec(over: Partial<UnderspendRecord>): UnderspendRecord {
  return {
    recordId: "r1",
    name: "Test Program",
    agency: null,
    jurisdiction: "Federal",
    program: null,
    allocated: 1_000_000,
    spent: 0,
    unspent: 1_000_000,
    fiscalYear: 2026,
    periodEnd: null,
    url: null,
    source: "usaspending",
    ...over,
  };
}

describe("underspend money helpers", () => {
  it("parseMoney handles suffixes, symbols, commas, numbers", () => {
    assert.equal(parseMoney("$1.18M"), 1_180_000);
    assert.equal(parseMoney("$11.6M"), 11_600_000);
    assert.equal(parseMoney("$450K"), 450_000);
    assert.equal(parseMoney("1,190,000"), 1_190_000);
    assert.equal(parseMoney("$2B"), 2_000_000_000);
    assert.equal(parseMoney(750000), 750_000);
    assert.equal(parseMoney(null), 0);
    assert.equal(parseMoney("n/a"), 0);
  });

  it("formatMoneyShort is compact", () => {
    assert.equal(formatMoneyShort(1_190_000), "$1.19M");
    assert.equal(formatMoneyShort(450_000), "$450K");
    assert.equal(formatMoneyShort(2_500_000_000), "$2.50B");
    assert.equal(formatMoneyShort(900), "$900");
  });

  it("pctUnspent + deriveUnspent", () => {
    assert.equal(pctUnspent({ allocated: 1_000_000, unspent: 980_000 }), 0.98);
    assert.equal(pctUnspent({ allocated: 0, unspent: 5 }), 1);
    assert.equal(deriveUnspent({ allocated: 1_000_000, spent: 200_000 }), 800_000);
    assert.equal(deriveUnspent({ allocated: 100, spent: 100, explicitUnspent: 750_000 }), 750_000);
    assert.equal(deriveUnspent({ allocated: 50, spent: 100 }), 0); // never negative
  });
});

describe("USASpending adapter (pure)", () => {
  it("currentFederalFiscalYear rolls over on Oct 1", () => {
    assert.equal(currentFederalFiscalYear(new Date("2026-06-05T00:00:00Z")), 2026);
    assert.equal(currentFederalFiscalYear(new Date("2026-10-01T00:00:00Z")), 2027);
    assert.equal(currentFederalFiscalYear(new Date("2026-09-30T00:00:00Z")), 2026);
  });

  it("buildFederalAccountsListRequest is a keyword-sorted accounts query", () => {
    const { url, body } = buildFederalAccountsListRequest({ keyword: "opioid", fiscalYear: 2026 });
    assert.match(url, /federal_accounts\/$/);
    assert.equal((body as { keyword: string }).keyword, "opioid");
    assert.deepEqual((body as { sort: unknown }).sort, { field: "budgetary_resources", direction: "desc" });
    assert.deepEqual((body as { filters: unknown }).filters, { fy: "2026" });
  });

  it("federalAccountDetailUrl carries the account code + fiscal year", () => {
    assert.equal(
      federalAccountDetailUrl("075-1363", 2026),
      "https://api.usaspending.gov/api/v2/federal_accounts/075-1363/?fiscal_year=2026",
    );
  });

  // Fixture mirrors the LIVE /federal_accounts/ list shape (verified 2026-06).
  it("parseFederalAccountsList keeps coded+named rows, skips junk", () => {
    const stubs = parseFederalAccountsList({
      results: [
        {
          account_number: "075-1363",
          account_name: "Mental Health, Substance Abuse and Mental Health Services Administration",
          managing_agency: "Department of Health and Human Services",
          managing_agency_acronym: "HHS",
          budgetary_resources: 3_371_900_000,
        },
        { account_name: "No code → skip", budgetary_resources: 5 },
        { account_number: "075-9999" }, // no name → skip
      ],
    });
    assert.equal(stubs.length, 1);
    assert.equal(stubs[0].code, "075-1363");
    assert.equal(stubs[0].agency, "Department of Health and Human Services");
    assert.equal(stubs[0].budgetaryResources, 3_371_900_000);
  });

  // Fixture mirrors the LIVE per-account detail shape (verified 2026-06).
  it("parseFederalAccountDetail derives unspent = resources − obligated", () => {
    const rec = parseFederalAccountDetail(
      {
        federal_account_code: "075-1363",
        account_title: "Mental Health, SAMHSA, HHS",
        parent_agency_name: "Department of Health and Human Services",
        bureau_name: "Substance Abuse and Mental Health Services Administration",
        total_obligated_amount: 1_000_000_000,
        total_gross_outlay_amount: 400_000_000,
        total_budgetary_resources: 3_371_900_000,
      },
      2026,
    );
    assert.ok(rec);
    assert.equal(rec!.unspent, 2_371_900_000); // 3.3719B − 1.0B obligated
    assert.equal(rec!.spent, 1_000_000_000);
    assert.equal(rec!.agency, "Department of Health and Human Services");
    assert.equal(rec!.recordId, "usa:2026:075-1363");
    assert.match(rec!.url ?? "", /federal_account\/075-1363/);
  });

  it("parseFederalAccountDetail skips fully-obligated accounts and garbage", () => {
    assert.equal(parseFederalAccountDetail(null, 2026), null);
    assert.equal(parseFederalAccountDetail({}, 2026), null);
    assert.equal(
      parseFederalAccountDetail(
        { federal_account_code: "x", account_title: "Spent", total_budgetary_resources: 100, total_obligated_amount: 100 },
        2026,
      ),
      null,
    );
    assert.deepEqual(parseFederalAccountsList(null), []);
    assert.deepEqual(parseFederalAccountsList({ results: "nope" }), []);
  });
});

describe("underspend registry dedupe", () => {
  it("underspendKey prefers recordId, then url, then name+agency", () => {
    assert.equal(underspendKey(rec({ recordId: "X" })), "id:x");
    assert.equal(underspendKey(rec({ recordId: "", url: "https://U" })), "url:https://u");
    assert.equal(
      underspendKey(rec({ recordId: "", url: null, name: "Foo", agency: "Bar" })),
      "na:foo|bar",
    );
  });
});

describe("underspend ranking model", () => {
  it("weights sum to 1", () => {
    const sum = Object.values(UNDERSPEND_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it("scores a big, mostly-unspent, on-theme NJ pool high", () => {
    const s = scoreUnderspend(
      rec({
        name: "Opioid Recovery & Behavioral Health Fund",
        agency: "NJ DHS",
        jurisdiction: "New Jersey",
        allocated: 51_000_000,
        spent: 1_000_000,
        unspent: 50_000_000,
        periodEnd: "2026-08-01",
      }),
      CTX,
    );
    assert.ok(s.score >= 70, `expected >=70, got ${s.score}`);
    assert.ok(s.reasons.some((r) => /unspent/.test(r)));
    assert.ok(s.reasons.some((r) => /Home-state/.test(r)));
  });

  it("scores a tiny, fully-utilized, off-theme federal pool below threshold", () => {
    const s = scoreUnderspend(
      rec({
        name: "Highway Bridge Maintenance",
        jurisdiction: "Federal",
        allocated: 20_000_000,
        spent: 19_800_000,
        unspent: 200_000,
        periodEnd: null,
      }),
      CTX,
    );
    assert.ok(s.score < UNDERSPEND_THRESHOLD, `expected < ${UNDERSPEND_THRESHOLD}, got ${s.score}`);
  });

  it("ranks higher-signal pools first and respects limit", () => {
    const ranked = rankUnderspend({
      records: [
        rec({ recordId: "a", name: "Small federal admin", jurisdiction: "Federal", allocated: 1_000_000, spent: 950_000, unspent: 50_000 }),
        rec({ recordId: "b", name: "NJ Opioid Recovery Fund", jurisdiction: "New Jersey", allocated: 10_000_000, spent: 100_000, unspent: 9_900_000, periodEnd: "2026-07-15" }),
        rec({ recordId: "c", name: "FL Behavioral Health Treatment", jurisdiction: "Florida", allocated: 4_000_000, spent: 500_000, unspent: 3_500_000 }),
      ],
      ctx: CTX,
      limit: 2,
    });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].record.recordId, "b"); // biggest NJ + lapsing
    assert.ok(ranked[0].score >= ranked[1].score);
  });
});

describe('underspend conditional "recovery" keyword gate', () => {
  // The live back-test (2026-06) showed bare "recovery" pulling off-theme giants
  // (Pacific Salmon Recovery, Cybersecurity Recovery Fund, Recovery-Act funds).
  // Per operator decision, "recovery" only counts WITH a co-occurring SUD term.
  it("marks a big recovery-ONLY federal pool off-theme (no core term)", () => {
    const s = scoreUnderspend(
      rec({
        name: "Pacific Coastal Salmon Recovery",
        agency: "National Oceanic and Atmospheric",
        jurisdiction: "Federal",
        allocated: 100_000_000,
        spent: 340_000,
        unspent: 99_660_000, // ~99% unspent — would score high on size alone
      }),
      CTX,
    );
    assert.equal(s.onTheme, false, "recovery alone must not count as on-theme");
    // No theme reason should be emitted for an off-theme pool.
    assert.ok(!s.reasons.some((r) => /Theme match/.test(r)));
  });

  it("counts recovery when a CORE substance term co-occurs", () => {
    const s = scoreUnderspend(
      rec({
        name: "NJ Opioid Recovery Fund",
        jurisdiction: "New Jersey",
        allocated: 10_000_000,
        spent: 100_000,
        unspent: 9_900_000,
      }),
      CTX,
    );
    assert.equal(s.onTheme, true);
    assert.ok(s.reasons.some((r) => /Theme match/.test(r) && /recovery/.test(r)));
  });

  it("isPersistableUnderspend gates off-theme pools even above threshold", () => {
    const salmon = rankUnderspend({
      records: [
        rec({
          recordId: "salmon",
          name: "Pacific Coastal Salmon Recovery",
          jurisdiction: "Federal",
          allocated: 100_000_000,
          spent: 340_000,
          unspent: 99_660_000,
        }),
      ],
      ctx: CTX,
    })[0];
    assert.ok(salmon.score >= UNDERSPEND_THRESHOLD, "size alone clears the score bar");
    assert.equal(salmon.onTheme, false);
    assert.equal(isPersistableUnderspend(salmon), false, "but the theme gate excludes it");

    const opioid = rankUnderspend({
      records: [
        rec({
          recordId: "opioid",
          name: "NJ Opioid Recovery Fund",
          jurisdiction: "New Jersey",
          allocated: 10_000_000,
          spent: 100_000,
          unspent: 9_900_000,
        }),
      ],
      ctx: CTX,
    })[0];
    assert.equal(isPersistableUnderspend(opioid), true);
  });
});

describe("underspend → pool mapping", () => {
  it("underspendPoolSource gives a stable per-source label", () => {
    assert.equal(underspendPoolSource("usaspending"), "USASpending.gov (auto)");
    assert.equal(underspendPoolSource("other"), "other (auto)");
  });
});
