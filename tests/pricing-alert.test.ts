// Unit tests for the pricing-integrity alert decision engine.
//
// decidePricingAlert is pure: submitted rows + previous state + `now` in,
// next state + at-most-one alert out. These fixtures pin the behaviours that
// decide whether the channel stays trustworthy: the standing backlog is
// baselined silently on first run, a known row never re-alerts, legitimate
// price absences (rate-based, RFI) stay quiet, the corruption signature (b)
// fires and reads differently from a mere missing price (a), and an
// undelivered alert retries because state was not advanced.
//
// Mutation notes — each guard was broken on purpose to prove the test bites
// (mutation applied, suite run, failure observed, mutation reverted):
//  - baseline guard: made the `prev == null` branch of decidePricingAlert
//    return its findings as newFindings (i.e. alert on the standing backlog)
//    -> "baselines the standing backlog without alerting" failed.
//  - re-alert guard: recorded only finding keys instead of `allKeys` in
//    next.reported -> "a corruption row that is also priceless … never comes
//    back as a new priceless alert" failed on the second run.
//  - suppression guard: made `legitimatelyUnpriced` return null for
//    rate-based bases -> "USTDA-shape rate-based quote is suppressed",
//    "NIST-shape blended-hourly basis is suppressed", and the backlog
//    baseline test all failed.
//  - unverified precedence: dropped the UNVERIFIED_BASIS early return ->
//    "unverified basis is never suppressed" failed (the row got suppressed
//    as rate-based because the fixture basis also mentions /hr).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyPricingRow,
  decidePricingAlert,
  type PricingRowInput,
  type PricingWatchState,
} from "../lib/pricing-alert";

const NOW = "2026-08-04T12:00:00.000Z";
const LATER = "2026-08-04T13:00:00.000Z";

function row(over: Partial<PricingRowInput> & { id: string }): PricingRowInput {
  return {
    solNumber: over.id,
    agency: "Test Agency",
    noticeType: "Solicitation",
    priceQuoted: null,
    priceBasis: null,
    texts: [],
    ...over,
  };
}

// The corruption signature as it actually reached the agencies (see
// tests/pricing-integrity.test.ts).
const MANGLED = "PRICING:\nFirm Fixed Price: ,800\n- Integration: ,000\nBlended rate: /hr\n";

// The 2026-08-04 standing backlog, in shape: one stale-unverified row, one
// rate-based, two Sources Sought/RFI, one bare row with no basis at all.
const BACKLOG: PricingRowInput[] = [
  row({ id: "1333ND26QNB640305", priceBasis: "amount unverified — no total line found" }),
  row({ id: "1131PL26R0049", priceBasis: "$155/hr blended" }),
  row({
    id: "270196",
    noticeType: "Sources Sought",
    priceBasis: "RFI ROI/cost projection requested; illustrative ranges only",
  }),
  row({ id: "M00264-26-RFI-029", noticeType: "Sources Sought", priceBasis: "ROM only: $180-260k" }),
  row({ id: "M6786126IMKMAI", noticeType: "Sources Sought" }),
];

describe("first run (no state)", () => {
  it("baselines the standing backlog without alerting", () => {
    const { newFindings, baselined, alertText, next } = decidePricingAlert(BACKLOG, null, NOW);
    assert.deepEqual(newFindings, []);
    assert.equal(alertText, null);
    // Only the non-suppressed row is recorded; suppressed rows need no key.
    assert.deepEqual(Object.keys(next.reported), ["1333ND26QNB640305:priceless"]);
    assert.equal(baselined.length, 1);
    assert.equal(baselined[0].condition, "priceless");
  });

  it("baselining a corrupted-and-priceless row records both keys silently", () => {
    const corrupt = row({
      id: "OLD-CORRUPT",
      texts: [{ kind: "event", source: "fp_events", text: MANGLED }],
    });
    const { newFindings, alertText, next } = decidePricingAlert([corrupt], null, NOW);
    assert.deepEqual(newFindings, []);
    assert.equal(alertText, null);
    assert.ok("OLD-CORRUPT:corruption" in next.reported);
    assert.ok("OLD-CORRUPT:priceless" in next.reported);
  });
});

describe("new occurrences", () => {
  function afterBaseline(): PricingWatchState {
    return decidePricingAlert(BACKLOG, null, NOW).next;
  }

  it("a row newly entering the priceless condition alerts once", () => {
    const state = afterBaseline();
    const rows = [...BACKLOG, row({ id: "NEW-001", priceBasis: null })];
    const first = decidePricingAlert(rows, state, LATER);
    assert.equal(first.newFindings.length, 1);
    assert.equal(first.newFindings[0].key, "NEW-001:priceless");
    assert.match(first.alertText ?? "", /NO PRICE RECORDED/);
    assert.match(first.alertText ?? "", /NEW-001/);

    // Same rows again with the persisted state: total silence.
    const second = decidePricingAlert(rows, first.next, LATER);
    assert.deepEqual(second.newFindings, []);
    assert.equal(second.alertText, null);
  });

  it("the baselined backlog never alerts on later runs either", () => {
    const state = afterBaseline();
    const { newFindings, alertText } = decidePricingAlert(BACKLOG, state, LATER);
    assert.deepEqual(newFindings, []);
    assert.equal(alertText, null);
  });
});

describe("legitimate price absence is suppressed", () => {
  it("USTDA-shape rate-based quote is suppressed", () => {
    const r = row({ id: "1131PL26R0049", priceBasis: "$155/hr blended" });
    const { findings, suppressed } = classifyPricingRow(r);
    assert.deepEqual(findings, []);
    assert.equal(suppressed?.reason, "rate-based price_basis");
  });

  it("NIST-shape blended-hourly basis is suppressed", () => {
    const r = row({ id: "NIST-1", priceBasis: "blended hourly rate $135/hour, no fixed total" });
    assert.equal(classifyPricingRow(r).findings.length, 0);
  });

  it("an RFI is suppressed (basis, notice type, or sol number)", () => {
    for (const r of [
      row({ id: "A", priceBasis: "RFI response; no pricing requested" }),
      row({ id: "B", noticeType: "Sources Sought" }),
      row({ id: "M00264-26-RFI-029" }),
    ]) {
      const { findings, suppressed } = classifyPricingRow(r);
      assert.deepEqual(findings, [], `expected ${r.id} suppressed`);
      assert.ok(suppressed, `expected ${r.id} to report a suppression reason`);
    }
  });

  it("unverified basis is never suppressed, even when it mentions a rate", () => {
    const r = row({ id: "X", priceBasis: "amount unverified — no total line found ($135/hr mentioned)" });
    const { findings, suppressed } = classifyPricingRow(r);
    assert.equal(suppressed, null);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].condition, "priceless");
  });

  it("a priced row with a normal basis produces nothing at all", () => {
    const r = row({ id: "OK-1", priceQuoted: 55000, priceBasis: "FFP $55,000 approved" });
    const { findings, keys, suppressed } = classifyPricingRow(r);
    assert.deepEqual(findings, []);
    assert.deepEqual(keys, []);
    assert.equal(suppressed, null);
  });
});

describe("condition (b) — the corruption signature", () => {
  it("fires on stripped-price artifacts and is distinguishable from (a)", () => {
    const state = decidePricingAlert(BACKLOG, null, NOW).next;
    const rows = [
      ...BACKLOG,
      row({
        id: "CORRUPT-1",
        texts: [{ kind: "event", source: "fp_events", text: MANGLED }],
      }),
      row({ id: "PLAIN-1" }),
    ];
    const { newFindings, alertText } = decidePricingAlert(rows, state, LATER);
    const conditions = new Map(newFindings.map((f) => [f.key, f.condition]));
    assert.equal(conditions.get("CORRUPT-1:corruption"), "corruption");
    assert.equal(conditions.get("PLAIN-1:priceless"), "priceless");
    // The alert text tells them apart, names the artifacts, and never quotes
    // the body.
    assert.match(alertText ?? "", /CORRUPTED TEXT \(act on this\): CORRUPT-1/);
    assert.match(alertText ?? "", /NO PRICE RECORDED \(may be fine\): PLAIN-1/);
    assert.match(alertText ?? "", /orphan_comma_group/);
    assert.doesNotMatch(alertText ?? "", /Firm Fixed Price/);
  });

  it("corruption is never suppressed — an RFI with mangled text still fires", () => {
    const r = row({
      id: "RFI-CORRUPT",
      noticeType: "Sources Sought",
      texts: [{ kind: "event", source: "fp_events", text: MANGLED }],
    });
    const { findings } = classifyPricingRow(r);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].condition, "corruption");
  });

  it("a draft that claims pricing but has no dollar figure fires (b)…", () => {
    const r = row({
      id: "NODOLLAR",
      texts: [{ kind: "draft", source: "draft:quote.md", text: "Quotation for services.\nTotal firm fixed price as discussed.\n" }],
    });
    const { findings } = classifyPricingRow(r);
    assert.equal(findings[0]?.condition, "corruption");
    assert.match(findings[0].detail, /no intact dollar figure/);
  });

  it("…but not for a legitimately unpriced row, and not for event notes", () => {
    const rfi = row({
      id: "RFI-NODOLLAR",
      noticeType: "Sources Sought",
      texts: [{ kind: "draft", source: "draft:rfi.md", text: "Quote of capabilities, no pricing.\n" }],
    });
    assert.deepEqual(classifyPricingRow(rfi).findings, []);
    const note = row({
      id: "NOTE-1",
      priceQuoted: 1000,
      texts: [{ kind: "event", source: "fp_events", text: '{"note":"quote submitted"}' }],
    });
    assert.deepEqual(classifyPricingRow(note).findings, []);
  });

  it("a corruption row that is also priceless alerts once, and never comes back as a new priceless alert", () => {
    const corrupt = row({
      id: "BOTH-1",
      texts: [{ kind: "event", source: "fp_events", text: MANGLED }],
    });
    const first = decidePricingAlert([corrupt], { reported: {} }, NOW);
    assert.equal(first.newFindings.length, 1);
    assert.equal(first.newFindings[0].condition, "corruption");
    // Both keys recorded: the (a) condition must not surface later as "new".
    assert.ok("BOTH-1:corruption" in first.next.reported);
    assert.ok("BOTH-1:priceless" in first.next.reported);
    // Corrupted text cleaned up but still priceless: silence.
    const cleaned = row({ id: "BOTH-1" });
    const second = decidePricingAlert([cleaned], first.next, LATER);
    assert.deepEqual(second.newFindings, []);
  });

  it("a row already alerted as (a) escalates when corruption later appears", () => {
    const plain = row({ id: "ESC-1" });
    const first = decidePricingAlert([plain], { reported: {} }, NOW);
    assert.equal(first.newFindings[0]?.condition, "priceless");
    const nowCorrupt = row({
      id: "ESC-1",
      texts: [{ kind: "event", source: "fp_events", text: MANGLED }],
    });
    const second = decidePricingAlert([nowCorrupt], first.next, LATER);
    assert.equal(second.newFindings.length, 1);
    assert.equal(second.newFindings[0].condition, "corruption");
  });
});

describe("failed send retries", () => {
  it("if the runner keeps the previous state (send failed), the same findings re-emit next run", () => {
    const state: PricingWatchState = { reported: {} };
    const rows = [row({ id: "RETRY-1" })];
    const first = decidePricingAlert(rows, state, NOW);
    assert.equal(first.newFindings.length, 1);
    // Runner contract on send failure: persist `prev`, not `next`.
    const retry = decidePricingAlert(rows, state, LATER);
    assert.equal(retry.newFindings.length, 1);
    assert.equal(retry.newFindings[0].key, "RETRY-1:priceless");
    assert.equal(retry.alertText, first.alertText);
    // And once `next` IS persisted, silence.
    const after = decidePricingAlert(rows, first.next, LATER);
    assert.deepEqual(after.newFindings, []);
  });
});
