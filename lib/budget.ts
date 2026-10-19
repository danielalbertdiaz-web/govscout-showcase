// Item N2 — the budget engine (pure core).
//
// No competitor generates a compliant budget + budget narrative; budgets are
// where small orgs actually lose grants. This module is deterministic and
// network/db-free: given org facts (personnel, rates, subawards, other direct
// costs) it computes the federal-style budget table and emits a draft budget
// narrative. Rates default to Acme Consulting's documented structure
// (data/blocks/04-indirect-rates.md): fringe 20%, overhead 10% of
// salaries+fringe. Lakeside-style NICRA (% of MTDC) and the federal 10% de-minimis
// are supported via `indirectBase`.
//
// MTDC (modified total direct costs) follows 2 CFR 200.68: total direct costs
// excluding equipment and the portion of EACH subaward beyond its first
// $25,000.

export const EL_DEFAULT_FRINGE_PCT = 20;
export const EL_DEFAULT_INDIRECT_PCT = 10; // of salaries + fringe
export const FEDERAL_DE_MINIMIS_PCT = 10; // of MTDC
export const MTDC_SUBAWARD_CAP = 25_000;

export type IndirectBase = "salaries_fringe" | "mtdc" | "total_direct";

export type PersonnelLine = {
  role: string;
  annualSalary: number;
  /** Percent effort, 0–100. */
  ftePct: number;
  /** Months on the project (12 = full year). */
  months: number;
};

export type SubawardLine = {
  partner: string;
  amount: number;
  scope?: string;
  /** Fixed-price subcontracts (e.g. Brightline) carry their indirect inside the price. */
  fixedPrice?: boolean;
};

export type OtherDirectLine = {
  label: string;
  amount: number;
};

export type BudgetInput = {
  personnel: PersonnelLine[];
  /** Fringe as % of salaries. Default Acme 20. */
  fringeRatePct?: number;
  /** Indirect rate %. Default Acme 10. */
  indirectRatePct?: number;
  /** What the indirect rate applies to. Default Acme "salaries_fringe". */
  indirectBase?: IndirectBase;
  travel?: number;
  /** Equipment is excluded from MTDC per 2 CFR 200.1. */
  equipment?: number;
  supplies?: number;
  subawards?: SubawardLine[];
  otherDirect?: OtherDirectLine[];
};

export type BudgetTotals = {
  personnel: number;
  fringe: number;
  travel: number;
  equipment: number;
  supplies: number;
  subawards: number;
  otherDirect: number;
  totalDirect: number;
  mtdc: number;
  indirect: number;
  total: number;
};

export type BudgetLine = {
  category: string;
  label: string;
  amount: number;
  basis: string | null;
};

export type BudgetResult = {
  lines: BudgetLine[];
  totals: BudgetTotals;
  assumptions: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function personnelCost(p: PersonnelLine): number {
  const fte = Math.max(0, Math.min(100, p.ftePct)) / 100;
  const months = Math.max(0, p.months);
  return round2(p.annualSalary * fte * (months / 12));
}

export function computeBudget(input: BudgetInput): BudgetResult {
  const fringePct = input.fringeRatePct ?? EL_DEFAULT_FRINGE_PCT;
  const indirectPct = input.indirectRatePct ?? EL_DEFAULT_INDIRECT_PCT;
  const base: IndirectBase = input.indirectBase ?? "salaries_fringe";

  const lines: BudgetLine[] = [];
  const assumptions: string[] = [];

  // Personnel
  let personnel = 0;
  for (const p of input.personnel) {
    const cost = personnelCost(p);
    personnel = round2(personnel + cost);
    lines.push({
      category: "Personnel",
      label: p.role,
      amount: cost,
      basis: `${fmtUsd(p.annualSalary)}/yr × ${p.ftePct}% FTE × ${p.months} mo`,
    });
  }

  // Fringe
  const fringe = round2((personnel * fringePct) / 100);
  if (personnel > 0) {
    lines.push({
      category: "Fringe",
      label: `Fringe benefits @ ${fringePct}%`,
      amount: fringe,
      basis: `${fringePct}% of ${fmtUsd(personnel)} salaries`,
    });
    assumptions.push(`Fringe at ${fringePct}% of salaries.`);
  }

  // Simple direct categories
  const travel = round2(input.travel ?? 0);
  if (travel) lines.push({ category: "Travel", label: "Travel", amount: travel, basis: null });
  const equipment = round2(input.equipment ?? 0);
  if (equipment) {
    lines.push({ category: "Equipment", label: "Equipment", amount: equipment, basis: "Excluded from MTDC" });
  }
  const supplies = round2(input.supplies ?? 0);
  if (supplies) lines.push({ category: "Supplies", label: "Supplies", amount: supplies, basis: null });

  // Subawards
  let subTotal = 0;
  for (const s of input.subawards ?? []) {
    const amt = round2(s.amount);
    subTotal = round2(subTotal + amt);
    lines.push({
      category: "Contractual",
      label: `Subaward — ${s.partner}${s.scope ? ` (${s.scope})` : ""}`,
      amount: amt,
      basis: s.fixedPrice ? "Fixed-price; indirect included in price" : `First ${fmtUsd(MTDC_SUBAWARD_CAP)} counts toward MTDC`,
    });
  }

  // Other direct
  let other = 0;
  for (const o of input.otherDirect ?? []) {
    const amt = round2(o.amount);
    other = round2(other + amt);
    lines.push({ category: "Other", label: o.label, amount: amt, basis: null });
  }

  const totalDirect = round2(personnel + fringe + travel + equipment + supplies + subTotal + other);

  // MTDC per 2 CFR 200: exclude equipment + each subaward's portion over $25K.
  const subawardMtdc = (input.subawards ?? []).reduce(
    (sum, s) => sum + Math.min(Math.max(0, s.amount), MTDC_SUBAWARD_CAP),
    0,
  );
  const mtdc = round2(personnel + fringe + travel + supplies + other + subawardMtdc);

  // Indirect
  let indirectBaseAmt: number;
  let basisLabel: string;
  if (base === "mtdc") {
    indirectBaseAmt = mtdc;
    basisLabel = `${indirectPct}% of MTDC (${fmtUsd(mtdc)})`;
    assumptions.push(
      `Indirect at ${indirectPct}% of MTDC — equipment and each subaward's portion above ${fmtUsd(MTDC_SUBAWARD_CAP)} excluded per 2 CFR 200.`,
    );
  } else if (base === "total_direct") {
    indirectBaseAmt = totalDirect;
    basisLabel = `${indirectPct}% of total direct (${fmtUsd(totalDirect)})`;
    assumptions.push(`Indirect at ${indirectPct}% of total direct costs.`);
  } else {
    indirectBaseAmt = round2(personnel + fringe);
    basisLabel = `${indirectPct}% of salaries + fringe (${fmtUsd(indirectBaseAmt)})`;
    assumptions.push(`Indirect (overhead) at ${indirectPct}% of salaries + fringe — Acme's documented structure.`);
  }
  const indirect = round2((indirectBaseAmt * indirectPct) / 100);
  if (indirect > 0) {
    lines.push({ category: "Indirect", label: `Indirect costs`, amount: indirect, basis: basisLabel });
  }

  const total = round2(totalDirect + indirect);

  return {
    lines,
    totals: {
      personnel,
      fringe,
      travel,
      equipment,
      supplies,
      subawards: subTotal,
      otherDirect: other,
      totalDirect,
      mtdc,
      indirect,
      total,
    },
    assumptions,
  };
}

/**
 * Deterministic draft budget narrative (markdown). The model can polish it in
 * the workbench, but the NUMBERS come from the calculator — never the LLM.
 */
export function generateBudgetNarrative(input: BudgetInput, result: BudgetResult): string {
  const t = result.totals;
  const parts: string[] = [];
  parts.push(`## Budget Narrative\n`);
  parts.push(`**Total project budget: ${fmtUsd(t.total)}** (${fmtUsd(t.totalDirect)} direct + ${fmtUsd(t.indirect)} indirect).\n`);

  if (input.personnel.length) {
    parts.push(`### Personnel — ${fmtUsd(t.personnel)}`);
    for (const p of input.personnel) {
      parts.push(
        `- **${p.role}** — ${fmtUsd(personnelCost(p))}: ${fmtUsd(p.annualSalary)} annual salary at ${p.ftePct}% effort for ${p.months} months.`,
      );
    }
    parts.push(`\n### Fringe benefits — ${fmtUsd(t.fringe)}\nCalculated at ${input.fringeRatePct ?? EL_DEFAULT_FRINGE_PCT}% of salaries.`);
  }
  if (t.travel) parts.push(`### Travel — ${fmtUsd(t.travel)}\nProject-related travel, mileage, and convenings.`);
  if (t.equipment) parts.push(`### Equipment — ${fmtUsd(t.equipment)}\nCapitalized equipment (excluded from the MTDC indirect base).`);
  if (t.supplies) parts.push(`### Supplies — ${fmtUsd(t.supplies)}\nProgram and office supplies.`);
  if (input.subawards?.length) {
    parts.push(`### Contractual / subawards — ${fmtUsd(t.subawards)}`);
    for (const s of input.subawards) {
      parts.push(
        `- **${s.partner}** — ${fmtUsd(s.amount)}${s.scope ? `: ${s.scope}` : ""}${s.fixedPrice ? " (fixed-price; partner indirect included)" : ""}`,
      );
    }
  }
  if (t.otherDirect) parts.push(`### Other direct — ${fmtUsd(t.otherDirect)}`);
  parts.push(`### Indirect costs — ${fmtUsd(t.indirect)}`);
  parts.push(result.assumptions.map((a) => `- ${a}`).join("\n"));
  return parts.join("\n\n");
}
