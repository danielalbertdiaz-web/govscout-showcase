import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_DISPOSITIONS,
  isDisposition,
  isWin,
  isDecidedOutcome,
  dollarBand,
  parseDollarAmount,
  scoreDimensionMatch,
  rankRelevantDispositions,
  computeCalibration,
  summarizeDispositions,
  type OppDimensions,
  type DispositionRecord,
  type Disposition,
} from "../lib/disposition";

test("disposition taxonomy guards", () => {
  for (const d of TERMINAL_DISPOSITIONS) assert.ok(isDisposition(d));
  assert.ok(!isDisposition("maybe"));
  assert.ok(!isDisposition(""));
  assert.ok(isWin("won"));
  assert.ok(!isWin("lost"));
  // Only won/lost are decided competitive outcomes.
  assert.ok(isDecidedOutcome("won"));
  assert.ok(isDecidedOutcome("lost"));
  assert.ok(!isDecidedOutcome("no_go"));
  assert.ok(!isDecidedOutcome("passed_pre_draft"));
  assert.ok(!isDecidedOutcome("expired_no_action"));
});

test("dollarBand buckets across Acme Consulting deal sizes", () => {
  assert.equal(dollarBand(null), null);
  assert.equal(dollarBand(0), null);
  assert.equal(dollarBand(-5), null);
  assert.equal(dollarBand(50_000), "micro");
  assert.equal(dollarBand(99_999), "micro");
  assert.equal(dollarBand(100_000), "small");
  assert.equal(dollarBand(999_999), "small");
  assert.equal(dollarBand(1_000_000), "mid");
  assert.equal(dollarBand(9_999_999), "mid");
  assert.equal(dollarBand(10_000_000), "large");
  assert.equal(dollarBand(49_999_999), "large");
  assert.equal(dollarBand(50_000_000), "mega");
});

test("parseDollarAmount handles common formats", () => {
  assert.equal(parseDollarAmount("$1,500,000"), 1_500_000);
  assert.equal(parseDollarAmount("1.5M"), 1_500_000);
  assert.equal(parseDollarAmount("250k"), 250_000);
  assert.equal(parseDollarAmount("2B"), 2_000_000_000);
  assert.equal(parseDollarAmount("750000"), 750_000);
  assert.equal(parseDollarAmount(null), null);
  assert.equal(parseDollarAmount("not a number"), null);
});

test("scoreDimensionMatch only compares dimensions known on both sides", () => {
  const a: OppDimensions = {
    funder: "HRSA",
    mechanism: "623110",
    dollarBand: "mid",
    partner: null,
    role: "prime",
  };
  // Perfect overlap on the comparable dimensions (partner null on both → skipped).
  const b: OppDimensions = {
    funder: "hrsa",
    mechanism: "623110",
    dollarBand: "mid",
    partner: null,
    role: "prime",
  };
  assert.equal(scoreDimensionMatch(a, b), 1);

  // Different funder, everything else same → partial.
  const c: OppDimensions = { ...b, funder: "SAMHSA" };
  const partial = scoreDimensionMatch(a, c);
  assert.ok(partial > 0 && partial < 1);

  // Nothing comparable → 0.
  const empty: OppDimensions = {
    funder: null,
    mechanism: null,
    dollarBand: null,
    partner: null,
    role: null,
  };
  assert.equal(scoreDimensionMatch(a, empty), 0);
});

test("rankRelevantDispositions sorts by similarity then recency, drops zero-overlap", () => {
  const target: OppDimensions = {
    funder: "HRSA",
    mechanism: "623110",
    dollarBand: "mid",
    partner: "Riverside",
    role: "prime",
  };
  const rec = (id: string, dims: Partial<OppDimensions>, at: number, disposition: Disposition): DispositionRecord => ({
    opportunityId: id,
    title: id,
    disposition,
    note: null,
    at,
    dims: { funder: null, mechanism: null, dollarBand: null, partner: null, role: null, ...dims },
  });
  const history: DispositionRecord[] = [
    rec("exact-old", { funder: "HRSA", mechanism: "623110", dollarBand: "mid", partner: "Riverside", role: "prime" }, 1000, "won"),
    rec("exact-new", { funder: "HRSA", mechanism: "623110", dollarBand: "mid", partner: "Riverside", role: "prime" }, 2000, "lost"),
    rec("funder-only", { funder: "HRSA" }, 3000, "won"),
    rec("unrelated", { funder: "DOE" }, 4000, "lost"),
  ];
  const ranked = rankRelevantDispositions(target, history, 20);
  // unrelated has zero overlap with target on every comparable dim? funder differs
  // but is comparable → similarity 0 (no matched weight) so it's dropped.
  assert.deepEqual(ranked.map((r) => r.opportunityId), ["exact-new", "exact-old", "funder-only"]);
  // Tie between the two exact matches broken by recency (newer first).
  assert.equal(ranked[0].opportunityId, "exact-new");

  // limit is respected.
  assert.equal(rankRelevantDispositions(target, history, 1).length, 1);
});

test("computeCalibration buckets scores and reports decided win rate", () => {
  const samples = [
    { score: 90, disposition: "won" as const },
    { score: 85, disposition: "lost" as const },
    { score: 82, disposition: "won" as const },
    { score: 50, disposition: "lost" as const },
    { score: 55, disposition: "no_go" as const }, // not decided → excluded from rate
    { score: 10, disposition: "expired_no_action" as const },
  ];
  const bands = computeCalibration(samples, { min: 0, max: 100, bands: 5 });
  assert.equal(bands.length, 5);
  // Top band [80,100]: 3 samples, 2 decided wins of... won, lost, won → decided=3, wins=2.
  const top = bands[4];
  assert.equal(top.sampleSize, 3);
  assert.equal(top.decided, 3);
  assert.equal(top.wins, 2);
  assert.ok(Math.abs((top.winRate ?? 0) - 2 / 3) < 1e-9);
  // Mid band [40,60): score 50 lost + score 55 no_go → sampleSize 2, decided 1, wins 0.
  const mid = bands[2];
  assert.equal(mid.sampleSize, 2);
  assert.equal(mid.decided, 1);
  assert.equal(mid.winRate, 0);
  // Low band [0,20): one expired no-bid → decided 0 → winRate null.
  const low = bands[0];
  assert.equal(low.sampleSize, 1);
  assert.equal(low.decided, 0);
  assert.equal(low.winRate, null);
});

test("computeCalibration clamps out-of-range scores into edge bands", () => {
  const bands = computeCalibration(
    [
      { score: 250, disposition: "won" },
      { score: -40, disposition: "lost" },
    ],
    { min: 0, max: 100, bands: 5 },
  );
  assert.equal(bands[4].sampleSize, 1); // 250 clamped into top band
  assert.equal(bands[0].sampleSize, 1); // -40 clamped into bottom band
});

test("summarizeDispositions tallies wins/losses/no-bids and decided rate", () => {
  const mk = (disposition: Disposition): DispositionRecord => ({
    opportunityId: "x",
    title: "x",
    disposition,
    note: null,
    at: 0,
    dims: { funder: null, mechanism: null, dollarBand: null, partner: null, role: null },
  });
  const s = summarizeDispositions([mk("won"), mk("won"), mk("lost"), mk("no_go"), mk("expired_no_action")]);
  assert.equal(s.total, 5);
  assert.equal(s.won, 2);
  assert.equal(s.lost, 1);
  assert.equal(s.noBid, 2);
  assert.ok(Math.abs((s.decidedWinRate ?? 0) - 2 / 3) < 1e-9);
  assert.equal(summarizeDispositions([]).decidedWinRate, null);
});
