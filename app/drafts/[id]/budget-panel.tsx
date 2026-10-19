"use client";

// Item N2 — the budget engine panel. Live-computes a federal-style budget from
// org facts using the pure lib/budget core (numbers never come from the LLM),
// persists the inputs on the draft (meta.budget), and hands you a ready budget
// narrative. Defaults are Acme's documented rate structure.

import { useMemo, useState } from "react";
import {
  computeBudget,
  generateBudgetNarrative,
  fmtUsd,
  EL_DEFAULT_FRINGE_PCT,
  EL_DEFAULT_INDIRECT_PCT,
  type BudgetInput,
  type IndirectBase,
  type PersonnelLine,
  type SubawardLine,
} from "@/lib/budget";

const INPUT =
  "rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-900 shadow-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600/30";
const BTN_SECONDARY =
  "rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:opacity-50";
const BTN_ACCENT =
  "rounded-md border border-emerald-600 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50";

type Props = {
  draftId: string;
  initial?: BudgetInput | null;
};

export default function BudgetPanel({ draftId, initial }: Props) {
  const [personnel, setPersonnel] = useState<PersonnelLine[]>(
    initial?.personnel?.length ? initial.personnel : [{ role: "Project Director", annualSalary: 120000, ftePct: 50, months: 12 }],
  );
  const [subawards, setSubawards] = useState<SubawardLine[]>(initial?.subawards ?? []);
  const [fringePct, setFringePct] = useState<number>(initial?.fringeRatePct ?? EL_DEFAULT_FRINGE_PCT);
  const [indirectPct, setIndirectPct] = useState<number>(initial?.indirectRatePct ?? EL_DEFAULT_INDIRECT_PCT);
  const [indirectBase, setIndirectBase] = useState<IndirectBase>(initial?.indirectBase ?? "salaries_fringe");
  const [travel, setTravel] = useState<number>(initial?.travel ?? 0);
  const [equipment, setEquipment] = useState<number>(initial?.equipment ?? 0);
  const [supplies, setSupplies] = useState<number>(initial?.supplies ?? 0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input: BudgetInput = useMemo(
    () => ({
      personnel: personnel.filter((p) => p.role.trim() && p.annualSalary > 0),
      subawards: subawards.filter((s) => s.partner.trim() && s.amount > 0),
      fringeRatePct: fringePct,
      indirectRatePct: indirectPct,
      indirectBase,
      travel,
      equipment,
      supplies,
    }),
    [personnel, subawards, fringePct, indirectPct, indirectBase, travel, equipment, supplies],
  );

  const result = useMemo(() => computeBudget(input), [input]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/drafts/${draftId}/budget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ budget: input }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  function copyNarrative() {
    void navigator.clipboard.writeText(generateBudgetNarrative(input, result)).catch(() => {});
  }

  const num = (v: string): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
          Budget engine
        </h2>
        <div className="flex items-center gap-2">
          <button onClick={copyNarrative} className={BTN_SECONDARY} disabled={result.totals.total === 0}>
            Copy narrative
          </button>
          <button onClick={() => void save()} className={BTN_ACCENT} disabled={saving}>
            {saving ? "Saving…" : savedAt ? "Saved ✓ — Save again" : "Save to draft"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-stone-500">
        Numbers come from the calculator, never the model. Defaults are Acme&rsquo;s documented rates
        (fringe {EL_DEFAULT_FRINGE_PCT}%, indirect {EL_DEFAULT_INDIRECT_PCT}% of salaries + fringe); MTDC follows 2 CFR 200.
      </p>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {/* Personnel rows */}
      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Personnel</div>
        <div className="mt-1.5 space-y-1.5">
          {personnel.map((p, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <input
                value={p.role}
                onChange={(e) => setPersonnel((xs) => xs.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                placeholder="Role"
                className={`${INPUT} w-44`}
              />
              <input
                type="number"
                value={p.annualSalary || ""}
                onChange={(e) => setPersonnel((xs) => xs.map((x, j) => (j === i ? { ...x, annualSalary: num(e.target.value) } : x)))}
                placeholder="Annual salary"
                className={`${INPUT} w-28`}
              />
              <label className="flex items-center gap-1 text-[11px] text-stone-500">
                <input
                  type="number"
                  value={p.ftePct || ""}
                  onChange={(e) => setPersonnel((xs) => xs.map((x, j) => (j === i ? { ...x, ftePct: num(e.target.value) } : x)))}
                  className={`${INPUT} w-16`}
                />
                % FTE
              </label>
              <label className="flex items-center gap-1 text-[11px] text-stone-500">
                <input
                  type="number"
                  value={p.months || ""}
                  onChange={(e) => setPersonnel((xs) => xs.map((x, j) => (j === i ? { ...x, months: num(e.target.value) } : x)))}
                  className={`${INPUT} w-14`}
                />
                mo
              </label>
              <span className="text-xs font-semibold text-stone-700">
                {fmtUsd(computeBudget({ personnel: [p] }).totals.personnel)}
              </span>
              <button
                onClick={() => setPersonnel((xs) => xs.filter((_, j) => j !== i))}
                className="text-xs text-stone-400 hover:text-rose-600"
                aria-label="Remove row"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => setPersonnel((xs) => [...xs, { role: "", annualSalary: 0, ftePct: 100, months: 12 }])}
          className={`mt-2 ${BTN_SECONDARY}`}
        >
          + Add person
        </button>
      </div>

      {/* Subawards */}
      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">Subawards / contractual</div>
        <div className="mt-1.5 space-y-1.5">
          {subawards.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <input
                value={s.partner}
                onChange={(e) => setSubawards((xs) => xs.map((x, j) => (j === i ? { ...x, partner: e.target.value } : x)))}
                placeholder="Partner"
                className={`${INPUT} w-40`}
              />
              <input
                type="number"
                value={s.amount || ""}
                onChange={(e) => setSubawards((xs) => xs.map((x, j) => (j === i ? { ...x, amount: num(e.target.value) } : x)))}
                placeholder="Amount"
                className={`${INPUT} w-28`}
              />
              <input
                value={s.scope ?? ""}
                onChange={(e) => setSubawards((xs) => xs.map((x, j) => (j === i ? { ...x, scope: e.target.value } : x)))}
                placeholder="Scope (optional)"
                className={`${INPUT} w-48`}
              />
              <label className="flex items-center gap-1 text-[11px] text-stone-500">
                <input
                  type="checkbox"
                  checked={Boolean(s.fixedPrice)}
                  onChange={(e) => setSubawards((xs) => xs.map((x, j) => (j === i ? { ...x, fixedPrice: e.target.checked } : x)))}
                />
                fixed-price
              </label>
              <button
                onClick={() => setSubawards((xs) => xs.filter((_, j) => j !== i))}
                className="text-xs text-stone-400 hover:text-rose-600"
                aria-label="Remove row"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() => setSubawards((xs) => [...xs, { partner: "", amount: 0 }])}
          className={`mt-2 ${BTN_SECONDARY}`}
        >
          + Add subaward
        </button>
      </div>

      {/* Rates + simple categories */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
          Fringe %
          <input type="number" value={fringePct} onChange={(e) => setFringePct(num(e.target.value))} className={`${INPUT} mt-1 block w-20`} />
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
          Indirect %
          <input type="number" value={indirectPct} onChange={(e) => setIndirectPct(num(e.target.value))} className={`${INPUT} mt-1 block w-20`} />
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
          Indirect base
          <select value={indirectBase} onChange={(e) => setIndirectBase(e.target.value as IndirectBase)} className={`${INPUT} mt-1 block`}>
            <option value="salaries_fringe">Salaries + fringe (Acme)</option>
            <option value="mtdc">MTDC (2 CFR 200)</option>
            <option value="total_direct">Total direct</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
          Travel
          <input type="number" value={travel || ""} onChange={(e) => setTravel(num(e.target.value))} className={`${INPUT} mt-1 block w-24`} />
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
          Equipment
          <input type="number" value={equipment || ""} onChange={(e) => setEquipment(num(e.target.value))} className={`${INPUT} mt-1 block w-24`} />
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-600">
          Supplies
          <input type="number" value={supplies || ""} onChange={(e) => setSupplies(num(e.target.value))} className={`${INPUT} mt-1 block w-24`} />
        </label>
      </div>

      {/* Computed table */}
      {result.lines.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-stone-50 text-left text-[10px] uppercase tracking-wider text-stone-500">
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Basis</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l, i) => (
                <tr key={i} className="border-t border-stone-100">
                  <td className="px-3 py-1.5 text-stone-500">{l.category}</td>
                  <td className="px-3 py-1.5 font-medium text-stone-900">{l.label}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-stone-900">{fmtUsd(l.amount)}</td>
                  <td className="px-3 py-1.5 text-stone-500">{l.basis ?? ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-stone-200 bg-stone-50">
                <td className="px-3 py-2 font-semibold text-stone-700" colSpan={2}>
                  Total direct {fmtUsd(result.totals.totalDirect)} · MTDC {fmtUsd(result.totals.mtdc)} · Indirect {fmtUsd(result.totals.indirect)}
                </td>
                <td className="px-3 py-2 text-right text-sm font-bold text-emerald-700">{fmtUsd(result.totals.total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
