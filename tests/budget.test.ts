import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  computeBudget,
  generateBudgetNarrative,
  personnelCost,
  fmtUsd,
  EL_DEFAULT_FRINGE_PCT,
  EL_DEFAULT_INDIRECT_PCT,
  FEDERAL_DE_MINIMIS_PCT,
  MTDC_SUBAWARD_CAP,
  type BudgetInput,
} from "../lib/budget";

describe("budget engine — personnel & fringe", () => {
  it("personnelCost = salary × FTE% × months/12", () => {
    assert.equal(personnelCost({ role: "PI", annualSalary: 120_000, ftePct: 50, months: 12 }), 60_000);
    assert.equal(personnelCost({ role: "PM", annualSalary: 90_000, ftePct: 100, months: 6 }), 45_000);
    assert.equal(personnelCost({ role: "X", annualSalary: 80_000, ftePct: 0, months: 12 }), 0);
    // FTE clamped to 0–100
    assert.equal(personnelCost({ role: "X", annualSalary: 80_000, ftePct: 150, months: 12 }), 80_000);
  });

  it("Acme defaults: fringe 20%, indirect 10% of salaries+fringe", () => {
    const r = computeBudget({
      personnel: [{ role: "Project Director", annualSalary: 100_000, ftePct: 100, months: 12 }],
    });
    assert.equal(r.totals.personnel, 100_000);
    assert.equal(r.totals.fringe, 20_000); // 20%
    assert.equal(r.totals.indirect, 12_000); // 10% of 120k
    assert.equal(r.totals.total, 132_000);
    assert.equal(EL_DEFAULT_FRINGE_PCT, 20);
    assert.equal(EL_DEFAULT_INDIRECT_PCT, 10);
  });
});

describe("budget engine — MTDC (2 CFR 200)", () => {
  const base: BudgetInput = {
    personnel: [{ role: "PI", annualSalary: 100_000, ftePct: 100, months: 12 }],
    fringeRatePct: 20,
    equipment: 50_000,
    subawards: [
      { partner: "Riverside", amount: 100_000, scope: "clinical services" },
      { partner: "Atlas Insights", amount: 20_000, scope: "data platform" },
    ],
    indirectBase: "mtdc",
    indirectRatePct: FEDERAL_DE_MINIMIS_PCT,
  };

  it("excludes equipment and subaward portions above $25K from MTDC", () => {
    const r = computeBudget(base);
    // direct = 100k + 20k fringe + 50k equip + 120k subs = 290k
    assert.equal(r.totals.totalDirect, 290_000);
    // MTDC = 100k + 20k + min(100k,25k) + min(20k,25k) = 165k (equipment excluded)
    assert.equal(r.totals.mtdc, 165_000);
    assert.equal(r.totals.indirect, 16_500); // 10% de-minimis of MTDC
    assert.equal(r.totals.total, 306_500);
    assert.equal(MTDC_SUBAWARD_CAP, 25_000);
  });

  it("salaries_fringe base ignores subawards/equipment entirely", () => {
    const r = computeBudget({ ...base, indirectBase: "salaries_fringe", indirectRatePct: 10 });
    assert.equal(r.totals.indirect, 12_000); // 10% of 120k
  });

  it("total_direct base uses the full direct total", () => {
    const r = computeBudget({ ...base, indirectBase: "total_direct", indirectRatePct: 10 });
    assert.equal(r.totals.indirect, 29_000); // 10% of 290k
  });
});

describe("budget engine — lines & narrative", () => {
  const input: BudgetInput = {
    personnel: [
      { role: "Project Director", annualSalary: 120_000, ftePct: 50, months: 12 },
      { role: "Clinical Lead", annualSalary: 140_000, ftePct: 25, months: 12 },
    ],
    travel: 8_000,
    supplies: 4_000,
    subawards: [{ partner: "Brightline", amount: 60_000, scope: "multilingual outreach", fixedPrice: true }],
    otherDirect: [{ label: "Participant incentives", amount: 10_000 }],
  };

  it("emits a line per item with bases, and a fixed-price marker", () => {
    const r = computeBudget(input);
    const cats = r.lines.map((l) => l.category);
    for (const c of ["Personnel", "Fringe", "Travel", "Supplies", "Contractual", "Other", "Indirect"]) {
      assert.ok(cats.includes(c), `missing category ${c}`);
    }
    const brightline = r.lines.find((l) => l.label.includes("Brightline"));
    assert.match(brightline!.basis ?? "", /Fixed-price/);
  });

  it("narrative carries the computed numbers, never invented ones", () => {
    const r = computeBudget(input);
    const md = generateBudgetNarrative(input, r);
    assert.match(md, /## Budget Narrative/);
    assert.ok(md.includes(fmtUsd(r.totals.total)));
    assert.ok(md.includes(fmtUsd(r.totals.fringe)));
    assert.ok(md.includes("Project Director"));
    assert.ok(md.includes("Brightline"));
    assert.match(md, /fixed-price/i);
  });

  it("zero-input budget is all zeros, no crash", () => {
    const r = computeBudget({ personnel: [] });
    assert.equal(r.totals.total, 0);
    assert.equal(r.lines.length, 0);
  });
});
