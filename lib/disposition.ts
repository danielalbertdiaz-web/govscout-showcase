// Item 3.1 — Win/loss feedback loop: pure, testable core.
//
// This module knows NOTHING about the database, the model, or fs. It defines
// the terminal disposition taxonomy, the "how similar are two opportunities"
// dimension match used to surface relevant prior outcomes to the council, and
// the confidence-calibration math (scoring band vs. actual win rate). The thin
// db/council/route shells import from here; all the branching logic lives here
// so it can be exercised in isolation by tests/disposition.test.ts.

// --- Terminal dispositions -------------------------------------------------

// The five terminal outcomes named in the brief. NULL (absent) == undecided.
export const TERMINAL_DISPOSITIONS = [
  "won",
  "lost",
  "no_go",
  "passed_pre_draft",
  "expired_no_action",
] as const;

export type Disposition = (typeof TERMINAL_DISPOSITIONS)[number];

export function isDisposition(s: string): s is Disposition {
  return (TERMINAL_DISPOSITIONS as readonly string[]).includes(s);
}

// Human-facing labels for the UI / prompt rendering.
export const DISPOSITION_LABELS: Record<Disposition, string> = {
  won: "Won",
  lost: "Lost",
  no_go: "No-go (declined to pursue)",
  passed_pre_draft: "Passed at pre-draft",
  expired_no_action: "Expired with no action",
};

// Did we submit and win? Only `won` counts as a win.
export function isWin(d: Disposition): boolean {
  return d === "won";
}

// Was this a decided competitive outcome (we submitted and learned win/loss)?
// no-go / passed / expired are no-bids: they tell us about *selection*, not about
// whether a submitted proposal wins. Calibration win-rate uses only decided ones.
export function isDecidedOutcome(d: Disposition): boolean {
  return d === "won" || d === "lost";
}

// --- Dimension model -------------------------------------------------------

// The five matching dimensions from the brief: funder, mechanism, dollar range,
// partner used, prime vs sub. Some are unknown today (partner/role land with
// item 4.1); matching degrades gracefully when a dimension is null on either side.
export type OppDimensions = {
  funder: string | null; // normalized agency / funder name
  mechanism: string | null; // grant mechanism / source family (e.g. naics, program type)
  dollarBand: DollarBand | null;
  partner: string | null; // consortium partner used, if any
  role: "prime" | "sub" | null;
};

export type DollarBand = "micro" | "small" | "mid" | "large" | "mega";

// Buckets chosen for the Acme Consulting deal sizes: sub-$100k is micro, the
// $100k–$1M band is the bread-and-butter "small", $1M–$10M "mid", up to $50M
// "large", beyond that "mega". Returns null when no dollar figure is known.
export function dollarBand(amount: number | null | undefined): DollarBand | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  if (amount < 100_000) return "micro";
  if (amount < 1_000_000) return "small";
  if (amount < 10_000_000) return "mid";
  if (amount < 50_000_000) return "large";
  return "mega";
}

// Parse a free-text dollar string ("$1,500,000", "1.5M", "250k") to a number.
// Used to derive a dollar band from the funding_ceiling/floor text columns.
export function parseDollarAmount(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[$,\s]/g, "");
  const m = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([kKmMbB])?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "k") n *= 1_000;
  else if (suffix === "m") n *= 1_000_000;
  else if (suffix === "b") n *= 1_000_000_000;
  return n;
}

function norm(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase().replace(/\s+/g, " ");
  return t.length ? t : null;
}

// --- Dimension matching ----------------------------------------------------

// Weights reflect how strongly each shared dimension predicts a comparable
// outcome. Funder match matters most (same reviewers, same priorities); dollar
// band and mechanism next; partner and prime/sub round it out. Total weight is
// normalized so a perfect match scores 1.0 regardless of how many dimensions
// are known on the target.
const DIMENSION_WEIGHTS: Record<keyof OppDimensions, number> = {
  funder: 0.35,
  mechanism: 0.2,
  dollarBand: 0.2,
  partner: 0.15,
  role: 0.1,
};

// Similarity in [0,1], scored against the TARGET's known dimensions. The
// denominator is the weight of every dimension we know about the opportunity
// we're evaluating; a prior outcome earns a dimension's weight only when it both
// knows and agrees on that dimension. So a sparse prior that matches its one
// known field is correctly weaker evidence than a full five-dimension match —
// it simply leaves the target's other dimensions unaccounted for. Returns 0 when
// the target has no known dimensions to compare.
export function scoreDimensionMatch(target: OppDimensions, prior: OppDimensions): number {
  let matched = 0;
  let known = 0;
  for (const key of Object.keys(DIMENSION_WEIGHTS) as (keyof OppDimensions)[]) {
    const tv = key === "dollarBand" || key === "role" ? target[key] : norm(target[key]);
    if (tv == null) continue; // can't match a dimension we don't know on the target
    known += DIMENSION_WEIGHTS[key];
    const pv = key === "dollarBand" || key === "role" ? prior[key] : norm(prior[key]);
    if (pv != null && tv === pv) matched += DIMENSION_WEIGHTS[key];
  }
  if (known === 0) return 0;
  return matched / known;
}

export type DispositionRecord = {
  opportunityId: string;
  title: string;
  disposition: Disposition;
  note: string | null;
  at: number;
  dims: OppDimensions;
};

export type RankedDisposition = DispositionRecord & { similarity: number };

// Surface the most relevant prior outcomes for a target opportunity. Sorts by
// dimension similarity, breaking ties by recency, and keeps the top `limit`.
// Records with zero comparable overlap are dropped entirely — an irrelevant
// prior outcome is worse than none for calibrating the council.
export function rankRelevantDispositions(
  target: OppDimensions,
  history: DispositionRecord[],
  limit = 20,
): RankedDisposition[] {
  return history
    .map((rec) => ({ ...rec, similarity: scoreDimensionMatch(target, rec.dims) }))
    .filter((rec) => rec.similarity > 0)
    .sort((a, b) => (b.similarity - a.similarity) || (b.at - a.at))
    .slice(0, limit);
}

// --- Confidence calibration ------------------------------------------------

export type CalibrationBand = {
  label: string; // e.g. "80–100"
  lower: number; // inclusive
  upper: number; // exclusive (inclusive on the top band)
  sampleSize: number; // all dispositions in this score band
  decided: number; // won + lost (submitted) only
  wins: number;
  winRate: number | null; // wins / decided; null when decided === 0
};

export type CalibrationSample = { score: number; disposition: Disposition };

export type CalibrationOptions = {
  min?: number; // score scale lower bound (default 0)
  max?: number; // score scale upper bound (default 100)
  bands?: number; // number of equal-width bands (default 5)
};

// Bucket scored opportunities into equal-width score bands and report the actual
// decided win rate in each. This is the heart of the "are our scores honest?"
// curve on /learning: if the 80–100 band wins 30% of the time, the score is
// over-confident. Samples outside [min,max] are clamped into the edge bands.
export function computeCalibration(
  samples: CalibrationSample[],
  opts: CalibrationOptions = {},
): CalibrationBand[] {
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const bandCount = Math.max(1, Math.floor(opts.bands ?? 5));
  const width = (max - min) / bandCount;

  const bands: CalibrationBand[] = Array.from({ length: bandCount }, (_, i) => {
    const lower = min + i * width;
    const upper = i === bandCount - 1 ? max : min + (i + 1) * width;
    return {
      label: `${round(lower)}–${round(upper)}`,
      lower,
      upper,
      sampleSize: 0,
      decided: 0,
      wins: 0,
      winRate: null,
    };
  });

  for (const s of samples) {
    if (!Number.isFinite(s.score)) continue;
    const clamped = Math.min(max, Math.max(min, s.score));
    let idx = Math.floor((clamped - min) / width);
    if (idx >= bandCount) idx = bandCount - 1;
    if (idx < 0) idx = 0;
    const band = bands[idx];
    band.sampleSize += 1;
    if (isDecidedOutcome(s.disposition)) {
      band.decided += 1;
      if (isWin(s.disposition)) band.wins += 1;
    }
  }

  for (const band of bands) {
    band.winRate = band.decided > 0 ? band.wins / band.decided : null;
  }
  return bands;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// Compact one-line summary of the win/loss record, used both in the council
// prompt header and the /learning summary card.
export function summarizeDispositions(history: DispositionRecord[]): {
  total: number;
  won: number;
  lost: number;
  noBid: number;
  decidedWinRate: number | null;
} {
  let won = 0;
  let lost = 0;
  let noBid = 0;
  for (const r of history) {
    if (r.disposition === "won") won += 1;
    else if (r.disposition === "lost") lost += 1;
    else noBid += 1;
  }
  const decided = won + lost;
  return {
    total: history.length,
    won,
    lost,
    noBid,
    decidedWinRate: decided > 0 ? won / decided : null,
  };
}
