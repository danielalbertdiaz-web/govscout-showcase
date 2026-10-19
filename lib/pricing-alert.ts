// Pricing-integrity alert decision engine (PRICING_CORRUPTION_2026-07-19).
//
// The defect class this exists for: on 2026-07-19 four federal quotations went
// out with every "$<digits>" token stripped. GovScout's ingest DETECTED it
// ("price_basis = amount unverified — no total line found") but only wrote a
// column; nothing read it, so nobody knew for sixteen days. This module makes
// that detection raise.
//
// Deliberately NOT part of the /api/health roll-up: a submitted quote with no
// price is a DATA problem, not an outage, and the health word must keep
// meaning exactly "is it up". Deliberately NOT a gate: rate-based quotes and
// RFIs correctly have no total, and a hard block would fight them until
// someone switched it off. Detect and raise; never block.
//
// Same discipline as lib/health-alert.ts: this module is PURE — no clock, no
// network, no filesystem. The runner (scripts/pricing-alert.mts) reads the
// production DB read-only, passes rows in, persists the returned state, and
// sends the Telegram message.
//
// Alerting is NEW-OCCURRENCES-ONLY. A first run with no prior state BASELINES
// every row currently in a bad condition without alerting — the standing
// backlog must never light the channel up on day one (that is how the 8
// abandoned crons trained everyone to ignore the health signal). A row/
// condition pair already recorded in state never re-alerts.

import { findStrippedPriceArtifacts, pricingDocumentHasDollarFigure } from "./pricing-integrity";

/** A text attached to a row, scanned for the corruption signature. */
export type RowText = {
  /**
   * "draft" = a staged proposal/quote document (draft_paths file). The
   * pricing-doc-must-have-a-dollar-figure invariant applies only here —
   * event notes are too short and too chatty for it.
   * "event" = fp_events detail / other DB prose.
   */
  kind: "draft" | "event";
  /** Where the text came from (file basename, "fp_events", ...). Shown in the alert; the text never is. */
  source: string;
  text: string;
};

/** One submitted fp_opportunities row, as the runner reads it. */
export type PricingRowInput = {
  id: string;
  solNumber: string | null;
  agency: string | null;
  noticeType: string | null;
  priceQuoted: number | null;
  priceBasis: string | null;
  texts: RowText[];
};

/**
 * "corruption" — condition (b): the stripped-dollar signature (or a pricing
 * document with no intact dollar figure) was found in text attached to the
 * row. This text WAS corrupted; act on it.
 * "priceless" — condition (a): the row is submitted with no usable price.
 * Might be fine (rate-based / RFI absences are suppressed below), might not.
 */
export type PricingCondition = "corruption" | "priceless";

export type PricingFinding = {
  /** State key — one alert ever per (row, condition). */
  key: string;
  condition: PricingCondition;
  solNumber: string | null;
  agency: string | null;
  /** Terse, actionable, and never contains quotation body text. */
  detail: string;
};

export type SuppressedRow = { id: string; solNumber: string | null; reason: string };

/** Persisted between runs: (row:condition) -> ISO date first reported or baselined. */
export type PricingWatchState = {
  reported: Record<string, string>;
};

// Legitimate absence of a total, cheaply detectable from recorded metadata:
//  - the basis names an hourly/blended rate or a T&M arrangement (NIST
//    1333ND26QNB640305 / USTDA 1131PL26R0049 shape);
//  - the basis or identifiers say RFI / ROM / sources sought — responses that
//    carry no binding price by design (HHS-RADV 270196 shape);
//  - the notice type itself is an unpriced kind (Sources Sought / RFI).
// Chosen from the live board's price_basis vocabulary; matching recorded
// metadata only (never body text) keeps the predicate cheap and auditable.
const RATE_BASED_BASIS = /\/\s*(?:hr|hour)\b|hourly|blended|labou?r[- ]hour|time\s*(?:&|and)\s*materials|\bT&M\b/i;
const UNPRICED_BY_DESIGN = /\bRFI\b|\bROM\b|rough order of magnitude|sources sought|request for information|no pricing requested|illustrative range/i;
const UNPRICED_NOTICE_TYPE = /sources sought|request for information|\bRFI\b|special notice/i;

// "amount unverified — no total line found" is the ingest saying it LOOKED
// for a price and could not verify one. That is a detection, not a
// legitimate-absence marker — it must never be suppressed.
const UNVERIFIED_BASIS = /unverified/i;

// A draft that claims to carry pricing must contain an intact dollar figure
// (pricingDocumentHasDollarFigure). Only applied to kind:"draft" texts.
const CLAIMS_PRICING = /\b(?:quotation|quote|firm fixed price|price proposal)\b/i;

function legitimatelyUnpriced(row: PricingRowInput): string | null {
  if (row.priceBasis != null && UNVERIFIED_BASIS.test(row.priceBasis)) return null;
  if (row.priceBasis != null && RATE_BASED_BASIS.test(row.priceBasis)) {
    return "rate-based price_basis";
  }
  if (row.priceBasis != null && UNPRICED_BY_DESIGN.test(row.priceBasis)) {
    return "RFI/ROM price_basis";
  }
  if (row.noticeType != null && UNPRICED_NOTICE_TYPE.test(row.noticeType)) {
    return `notice_type "${row.noticeType}"`;
  }
  if (row.solNumber != null && /RFI/i.test(row.solNumber)) {
    return "RFI solicitation number";
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Classify one submitted row. Returns the findings to (potentially) alert on,
 * plus every state key this row currently occupies — when a corruption
 * finding subsumes a priceless one, both keys are recorded so the row cannot
 * come back next run as a "new" priceless alert.
 */
export function classifyPricingRow(row: PricingRowInput): {
  findings: PricingFinding[];
  keys: string[];
  suppressed: SuppressedRow | null;
} {
  const label = row.solNumber ?? row.id;

  // Condition (b) — the corruption signature. Never suppressed: an artifact
  // match is the smoking gun regardless of how the row is priced.
  const artifactSources: string[] = [];
  const kindCounts = new Map<string, number>();
  let noDollarDraft: string | null = null;
  for (const t of row.texts) {
    const hits = findStrippedPriceArtifacts(t.text);
    if (hits.length > 0) {
      artifactSources.push(t.source);
      for (const h of hits) kindCounts.set(h.kind, (kindCounts.get(h.kind) ?? 0) + 1);
    }
    if (
      t.kind === "draft" &&
      CLAIMS_PRICING.test(t.text) &&
      !pricingDocumentHasDollarFigure(t.text)
    ) {
      noDollarDraft = t.source;
    }
  }

  const suppressReason = legitimatelyUnpriced(row);
  const findings: PricingFinding[] = [];
  const keys: string[] = [];

  const corrupted =
    artifactSources.length > 0 || (noDollarDraft != null && suppressReason == null);
  if (corrupted) {
    const what =
      artifactSources.length > 0
        ? `stripped-price artifacts (${[...kindCounts.entries()]
            .map(([k, n]) => `${k} x${n}`)
            .join(", ")}) in ${artifactSources.join(", ")}`
        : `pricing document ${noDollarDraft} contains no intact dollar figure`;
    findings.push({
      key: `${row.id}:corruption`,
      condition: "corruption",
      solNumber: row.solNumber,
      agency: row.agency,
      detail: what,
    });
    keys.push(`${row.id}:corruption`);
  }

  // Condition (a) — submitted with no usable price.
  const priceless =
    row.priceQuoted == null || (row.priceBasis != null && UNVERIFIED_BASIS.test(row.priceBasis));
  if (priceless) {
    if (suppressReason != null) {
      return {
        findings,
        keys,
        suppressed: { id: row.id, solNumber: row.solNumber, reason: suppressReason },
      };
    }
    keys.push(`${row.id}:priceless`);
    if (!corrupted) {
      // A corruption finding subsumes the priceless one — one alert, both
      // keys recorded above/here.
      findings.push({
        key: `${row.id}:priceless`,
        condition: "priceless",
        solNumber: row.solNumber,
        agency: row.agency,
        detail:
          row.priceBasis != null
            ? `no usable price; basis: "${truncate(row.priceBasis, 70)}"`
            : "no price_quoted and no price_basis recorded",
      });
    }
  }

  return { findings, keys, suppressed: null };
}

/** Render at-most-one Telegram message for a run's new findings. */
export function buildPricingAlertText(newFindings: PricingFinding[]): string | null {
  if (newFindings.length === 0) return null;
  const MAX_LINES = 6;
  // Corruption first — it is the actionable signal.
  const ordered = [...newFindings].sort((a, b) =>
    a.condition === b.condition ? 0 : a.condition === "corruption" ? -1 : 1,
  );
  const lines = ordered.slice(0, MAX_LINES).map((f) => {
    const head =
      f.condition === "corruption"
        ? "CORRUPTED TEXT (act on this)"
        : "NO PRICE RECORDED (may be fine)";
    return `- ${head}: ${f.solNumber ?? "(no sol number)"}${f.agency ? ` / ${f.agency}` : ""} — ${f.detail}`;
  });
  if (ordered.length > MAX_LINES) lines.push(`- …and ${ordered.length - MAX_LINES} more.`);
  return (
    `GovScout pricing integrity: ${newFindings.length} new issue(s) on submitted quotes.\n` +
    lines.join("\n") +
    `\nLook: /bid-board or \`npm run fp -- show <sol>\`.`
  );
}

/**
 * One run's decision. `prev == null` means first run: baseline everything
 * currently in a bad condition — record it, alert on none of it. Otherwise
 * alert only on (row, condition) keys not already in state. Keys are never
 * pruned: a row already known must never re-alert.
 */
export function decidePricingAlert(
  rows: PricingRowInput[],
  prev: PricingWatchState | null,
  nowIso: string,
): {
  next: PricingWatchState;
  /** Findings to alert on this run (always empty on the baseline run). */
  newFindings: PricingFinding[];
  /** First-run only: what was recorded silently. */
  baselined: PricingFinding[];
  suppressed: SuppressedRow[];
  alertText: string | null;
} {
  const classified = rows.map(classifyPricingRow);
  const suppressed = classified.flatMap((c) => (c.suppressed ? [c.suppressed] : []));
  const findings = classified.flatMap((c) => c.findings);
  const allKeys = classified.flatMap((c) => c.keys);

  if (prev == null) {
    const reported: Record<string, string> = {};
    for (const k of allKeys) reported[k] = nowIso;
    return { next: { reported }, newFindings: [], baselined: findings, suppressed, alertText: null };
  }

  const reported = { ...prev.reported };
  const newFindings = findings.filter((f) => !(f.key in reported));
  for (const k of allKeys) if (!(k in reported)) reported[k] = nowIso;
  return {
    next: { reported },
    newFindings,
    baselined: [],
    suppressed,
    alertText: buildPricingAlertText(newFindings),
  };
}
