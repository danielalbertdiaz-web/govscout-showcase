import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  FUNNELS,
  isFunnelKey,
  buildPersonaSetPrompt,
  buildDecisionPrompt,
  extractJson,
  clamp01,
  parsePersonaSet,
  parseStageDecisions,
  mulberry32,
  monteCarlo,
  aggregate,
  renderReportMd,
  parseLegacyPanelReport,
  legacyToPanel,
  derivedActionProbability,
  type Persona,
  type PersonaDecisions,
} from "../lib/panel-sim";

const FUNNEL = FUNNELS["coldemail-deck"];

const PERSONA: Persona = {
  idx: 1,
  name: "Rosa Vargas",
  role: "Director of Health Services",
  jurisdiction: "Passaic City NJ",
  profile: "Urban NJ health director, bilingual programming, opioid settlement funds in hand.",
  traits: { tenure_years: 9 },
};

function panelOf(probs: number[][]): PersonaDecisions[] {
  return probs.map((ps, pi) => ({
    persona: { ...PERSONA, idx: pi + 1, name: `P${pi + 1}` },
    decisions: ps.map((p, si) => ({
      stage: FUNNEL[si].key,
      stageIdx: si,
      probability: p,
      verdict: null,
      verbatim: null,
      detail: null,
    })),
  }));
}

describe("panel-sim prompts (pure)", () => {
  it("persona-set prompt embeds spec, count, and anti-cheerleading rule", () => {
    const p = buildPersonaSetPrompt("38 states, urban/rural mix, vendor-burned skeptics", 16);
    assert.match(p, /Generate 16 distinct/);
    assert.match(p, /vendor-burned skeptics/);
    assert.match(p, /hate the artifact/);
    assert.match(p, /JSON array/);
  });

  it("decision prompt carries persona, artifacts, and every stage key", () => {
    const p = buildDecisionPrompt(
      PERSONA,
      [{ name: "cover-note.md", content: "Dear officer..." }],
      FUNNEL,
    );
    assert.match(p, /Rosa Vargas/);
    assert.match(p, /Dear officer/);
    for (const s of FUNNEL) assert.match(p, new RegExp(`"${s.key}"`));
    assert.match(p, /conditional probability/);
  });

  it("funnel registry knows its keys", () => {
    assert.equal(isFunnelKey("coldemail-deck"), true);
    assert.equal(isFunnelKey("email-only"), true);
    assert.equal(isFunnelKey("nope"), false);
  });
});

describe("tolerant parsers (pure)", () => {
  it("extractJson survives fences, prose, and trailing text", () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n[{"a":1}]\nHope that helps!'), [{ a: 1 }]);
    assert.equal(extractJson("no json at all"), null);
  });

  it("clamp01 clamps, and tolerates percent-style answers", () => {
    assert.equal(clamp01(0.4), 0.4);
    assert.equal(clamp01(-3), 0);
    assert.equal(clamp01(1), 1);
    assert.equal(clamp01(35), 0.35); // "35" meaning 35%
    assert.equal(clamp01("garbage"), 0);
  });

  it("parsePersonaSet builds indexed personas and caps at n", () => {
    const text = JSON.stringify([
      { name: "A", role: "r", jurisdiction: "j", profile: "p", traits: { x: 1 } },
      { name: "B", profile: "q" },
      { name: "C", profile: "extra beyond n" },
    ]);
    const ps = parsePersonaSet(text, 2);
    assert.equal(ps.length, 2);
    assert.equal(ps[0].idx, 1);
    assert.equal(ps[1].name, "B");
    assert.equal(ps[1].role, null);
    assert.deepEqual(ps[0].traits, { x: 1 });
    assert.deepEqual(parsePersonaSet("not json", 5), []);
  });

  it("parseStageDecisions aligns to the funnel and backfills missing stages pessimistically", () => {
    const text = JSON.stringify({
      stages: [
        { stage: "inbox_open", probability: 0.75, verdict: "works", verbatim: "I open it." },
        { stage: "deck_open", probability: 0.9 },
        { stage: "made_up_stage", probability: 1 },
      ],
    });
    const ds = parseStageDecisions(text, FUNNEL);
    assert.equal(ds.length, FUNNEL.length);
    assert.equal(ds[0].probability, 0.75);
    assert.equal(ds[0].verdict, "works");
    assert.equal(ds[1].probability, 0); // email_read missing → 0, never optimistic
    assert.equal(ds[2].probability, 0.9);
    assert.equal(ds[3].probability, 0);
    assert.ok(!ds.some((d) => d.stage === "made_up_stage"));
  });
});

describe("monteCarlo (pure, deterministic)", () => {
  it("same seed → identical results; different seed → different draw", () => {
    const panel = panelOf([
      [0.5, 0.5, 0.5, 0.5],
      [0.9, 0.8, 0.7, 0.6],
    ]);
    const a = monteCarlo(panel, 500, 42);
    const b = monteCarlo(panel, 500, 42);
    assert.deepEqual(a, b);
    const c = monteCarlo(panel, 500, 43);
    assert.notDeepEqual(a.stages, c.stages);
  });

  it("probability-1 chain converts everyone; probability-0 first stage kills the funnel", () => {
    const sure = monteCarlo(panelOf([[1, 1, 1, 1]]), 200, 7);
    for (const s of sure.stages) {
      assert.equal(s.mean, 1);
      assert.deepEqual(s.ci95, [1, 1]);
    }
    const dead = monteCarlo(panelOf([[0, 1, 1, 1]]), 200, 7);
    for (const s of dead.stages) assert.equal(s.mean, 0);
  });

  it("means approximate the analytic funnel product at N=2000", () => {
    // Single persona, p = .8 → .5 → .5 → .25; expected pass-throughs:
    // .8, .4, .2, .05
    const mc = monteCarlo(panelOf([[0.8, 0.5, 0.5, 0.25]]), 2000, 42);
    const expected = [0.8, 0.4, 0.2, 0.05];
    mc.stages.forEach((s, i) => {
      assert.ok(
        Math.abs(s.mean - expected[i]) < 0.05,
        `stage ${s.stage}: mean ${s.mean} not within 0.05 of ${expected[i]}`,
      );
    });
  });

  it("mulberry32 is stable across calls with the same seed", () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    const seq1 = [r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2()];
    assert.deepEqual(seq1, seq2);
    for (const v of seq1) assert.ok(v >= 0 && v < 1);
  });
});

describe("aggregate + report (pure)", () => {
  const panel: PersonaDecisions[] = [
    {
      persona: { ...PERSONA, idx: 1, name: "Fan" },
      decisions: [
        { stage: "inbox_open", stageIdx: 0, probability: 0.8, verdict: "works", verbatim: "Opens fast.", detail: null },
        { stage: "email_read", stageIdx: 1, probability: 0.9, verdict: "moving, not manipulative", verbatim: null, detail: null },
        { stage: "deck_open", stageIdx: 2, probability: 0.9, verdict: "works", verbatim: null, detail: null },
        { stage: "action", stageIdx: 3, probability: 0.7, verdict: "works", verbatim: "First real thing in two years.", detail: null },
      ],
    },
    {
      persona: { ...PERSONA, idx: 2, name: "Skeptic" },
      decisions: [
        { stage: "inbox_open", stageIdx: 0, probability: 0.4, verdict: "neutral", verbatim: null, detail: null },
        { stage: "email_read", stageIdx: 1, probability: 0.5, verdict: "mildly manipulative", verbatim: "Thumb on the scale.", detail: null },
        { stage: "deck_open", stageIdx: 2, probability: 0.5, verdict: "gimmicky", verbatim: null, detail: null },
        { stage: "action", stageIdx: 3, probability: 0.05, verdict: "archives, does not reply", verbatim: "Need references and a price sheet.", detail: null },
      ],
    },
  ];

  it("splits verdicts per stage with fuzzy classification", () => {
    const agg = aggregate(panel);
    assert.equal(agg.panelSize, 2);
    assert.equal(agg.verdictSplits["email_read"].works, 1); // "moving, not manipulative"
    assert.equal(agg.verdictSplits["email_read"].backfires, 1); // "mildly manipulative"
    assert.equal(agg.verdictSplits["deck_open"].backfires, 1); // "gimmicky"
  });

  it("risk-flags low-probability decisions, lowest first", () => {
    const agg = aggregate(panel);
    assert.ok(agg.riskFlags.length >= 1);
    assert.equal(agg.riskFlags[0].persona, "Skeptic");
    assert.equal(agg.riskFlags[0].stage, "action");
  });

  it("collects one deepest verbatim per persona", () => {
    const agg = aggregate(panel);
    assert.equal(agg.topVerbatims.length, 2);
    assert.match(agg.topVerbatims[0].verbatim, /two years/);
    assert.match(agg.topVerbatims[1].verbatim, /price sheet/);
  });

  it("renders a markdown report with funnel table + advisory footer", () => {
    const mc = monteCarlo(panel, 300, 42);
    const md = renderReportMd({
      label: "Test run",
      funnelKey: "coldemail-deck",
      backend: "native",
      panel,
      mc,
      agg: aggregate(panel),
    });
    assert.match(md, /# Panel-Sim — Test run/);
    assert.match(md, /Inbox → Open/);
    assert.match(md, /95% interval/);
    assert.match(md, /Advisory only/);
  });
});
