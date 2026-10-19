// Panel-Sim pure core (spec: GOVSCOUT_PANEL_SIM_SPEC.md).
//
// A reusable reaction-panel / Monte Carlo backend: any artifact (cold email,
// campaign deck, proposal section) is war-gamed against an LLM persona panel.
// The honesty contract for "1000 decisions": the LLM estimates per-stage
// advance probabilities ONCE per persona; a seeded PRNG then samples 1000
// trajectories in code. No thousand LLM calls, no fabricated precision —
// confidence intervals come from the sampled distribution.
//
// Same discipline as lib/simulation.ts (the MiroFish seam): everything in this
// file is pure and unit-tested — prompt builders, tolerant parsers, sampler,
// aggregator. The impure shells live elsewhere (lib/panel-sim-native.ts drives
// the claude CLI; lib/panel-sim-store.ts owns SQLite; scripts/panel-sim.mts is
// the runner).
//
// TRUST GATE (inherited from the MiroFish seam's risk table): panel verdicts
// are advisory-only. Runs are filed as Decisions via lib/decisions.ts — a
// human makes the call, results never auto-gate anything.

// ---- Funnels ---------------------------------------------------------------

export type FunnelStage = {
  key: string;
  label: string;
  /** The question the persona answers at this stage. */
  question: string;
};

export const FUNNELS: Record<string, FunnelStage[]> = {
  "coldemail-deck": [
    {
      key: "inbox_open",
      label: "Inbox → Open",
      question:
        "Seeing only the sender and subject line in a crowded inbox, what is the probability you open this email?",
    },
    {
      key: "email_read",
      label: "Open → Read fully",
      question:
        "Having opened it, what is the probability you read the email to the end rather than bailing after the first lines?",
    },
    {
      key: "deck_open",
      label: "Read → Open deck",
      question:
        "Having read the email, what is the probability you click through and open the attached deck?",
    },
    {
      key: "action",
      label: "Deck → Reply / meeting",
      question:
        "Having reviewed the deck, what is the probability you take positive action (reply, forward internally, or book a call)?",
    },
  ],
  "email-only": [
    {
      key: "inbox_open",
      label: "Inbox → Open",
      question:
        "Seeing only the sender and subject line in a crowded inbox, what is the probability you open this email?",
    },
    {
      key: "email_read",
      label: "Open → Read fully",
      question:
        "Having opened it, what is the probability you read the email to the end rather than bailing after the first lines?",
    },
    {
      key: "action",
      label: "Read → Reply",
      question:
        "Having read the email, what is the probability you reply or take the requested action?",
    },
  ],
};

export function isFunnelKey(k: string): k is keyof typeof FUNNELS {
  return Object.prototype.hasOwnProperty.call(FUNNELS, k);
}

// ---- Types -----------------------------------------------------------------

export type Persona = {
  idx: number; // 1-based
  name: string;
  role: string | null;
  jurisdiction: string | null;
  profile: string;
  traits: Record<string, unknown>;
};

export type StageDecision = {
  stage: string;
  stageIdx: number;
  /** P(advance past this stage | reached it), clamped to [0,1]. */
  probability: number;
  verdict: string | null;
  verbatim: string | null;
  detail: Record<string, unknown> | null;
};

export type PersonaDecisions = {
  persona: Persona;
  decisions: StageDecision[];
};

export type Artifact = { name: string; content: string };

export type PanelRunInput = {
  label: string;
  panelSpec: string;
  artifacts: Artifact[];
  funnelKey: string;
  n: number;
  seed?: number;
  iterations?: number;
};

/**
 * The seam MiroFish later slots into (same pattern as lib/simulation.ts).
 * A backend produces personas + per-stage decisions; everything downstream
 * (monteCarlo, aggregate, persistence, Decision filing) is backend-agnostic,
 * so callers never change when a second backend appears.
 */
export interface PanelBackend {
  id: string;
  runPanel(input: PanelRunInput): Promise<PersonaDecisions[]>;
}

// ---- Prompt builders (pure) ------------------------------------------------

export function buildPersonaSetPrompt(spec: string, n: number): string {
  return [
    `Generate ${n} distinct, realistic personas for an audience reaction panel.`,
    `Ground every persona in this demographic specification — cover its full range, do not cluster on the median:`,
    ``,
    `<panel_spec>`,
    spec.trim(),
    `</panel_spec>`,
    ``,
    `Rules:`,
    `- Personas must be plausible individuals with names, not archetypes ("Persona 3").`,
    `- Vary the axes the spec names (geography, tenure, budget posture, temperament) AND include the awkward cases: skeptics, the burned, the no-budget, the wrong-recipient.`,
    `- No cheerleading bias: a realistic panel contains people who will hate the artifact.`,
    ``,
    `Return ONLY a JSON array (no prose, no markdown fence) of ${n} objects:`,
    `[{"name": "...", "role": "...", "jurisdiction": "...", "profile": "3-5 sentence prose profile", "traits": {"tenure_years": 0, "budget_posture": "...", "temperament": "..."}}]`,
  ].join("\n");
}

export function buildDecisionPrompt(
  persona: Persona,
  artifacts: Artifact[],
  funnel: FunnelStage[],
): string {
  const artifactBlocks = artifacts
    .map((a) => `<artifact name="${a.name}">\n${a.content}\n</artifact>`)
    .join("\n\n");
  const stageLines = funnel
    .map((s, i) => `${i + 1}. "${s.key}" — ${s.question}`)
    .join("\n");
  return [
    `You are role-playing ONE persona on an audience reaction panel. Stay in character; react as this person actually would, including negatively. No cheerleading.`,
    ``,
    `<persona>`,
    `Name: ${persona.name}`,
    persona.role ? `Role: ${persona.role}` : ``,
    persona.jurisdiction ? `Jurisdiction: ${persona.jurisdiction}` : ``,
    `Profile: ${persona.profile}`,
    `</persona>`,
    ``,
    artifactBlocks,
    ``,
    `Walk the funnel below stage by stage. At each stage assume you DID advance through the previous stages, and estimate the conditional probability (0.0-1.0) that you advance past THIS stage.`,
    ``,
    stageLines,
    ``,
    `Return ONLY a JSON object (no prose, no markdown fence):`,
    `{"stages": [{"stage": "<stage key>", "probability": 0.0, "verdict": "works|neutral|backfires", "verbatim": "one line of your internal monologue at this stage", "detail": {"<artifact element>": "your reaction"}}]}`,
    `Include every stage key exactly once, in order.`,
  ].join("\n");
}

// ---- Tolerant parsers (pure) -----------------------------------------------

/** Pull the first JSON value out of LLM text that may carry fences or prose. */
export function extractJson(text: string): unknown | null {
  const t = (text ?? "").trim();
  const candidates: string[] = [];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  candidates.push(t);
  // Also try from the first bracket to the last matching one.
  for (const open of ["[", "{"]) {
    const start = t.indexOf(open);
    const end = t.lastIndexOf(open === "[" ? "]" : "}");
    if (start !== -1 && end > start) candidates.push(t.slice(start, end + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* try next */
    }
  }
  return null;
}

export function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // Tolerate percent-style answers ("35" meaning 35%).
  const scaled = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, scaled));
}

export function parsePersonaSet(text: string, n: number): Persona[] {
  const parsed = extractJson(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, n).map((p, i) => {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    return {
      idx: i + 1,
      name: String(o.name ?? `Persona ${i + 1}`).trim() || `Persona ${i + 1}`,
      role: o.role != null ? String(o.role) : null,
      jurisdiction: o.jurisdiction != null ? String(o.jurisdiction) : null,
      profile: String(o.profile ?? "").trim(),
      traits:
        o.traits && typeof o.traits === "object"
          ? (o.traits as Record<string, unknown>)
          : {},
    };
  });
}

/**
 * Parse one persona's funnel walk. Missing stages are backfilled with
 * probability 0 (a persona that answered nothing advances nowhere — degrade
 * pessimistic, never optimistic). Extra/unknown stages are dropped.
 */
export function parseStageDecisions(text: string, funnel: FunnelStage[]): StageDecision[] {
  const parsed = extractJson(text);
  const rawStages =
    parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).stages)
      ? ((parsed as Record<string, unknown>).stages as unknown[])
      : Array.isArray(parsed)
        ? parsed
        : [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const s of rawStages) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const key = String(o.stage ?? "").trim();
    if (key && !byKey.has(key)) byKey.set(key, o);
  }
  return funnel.map((f, i) => {
    const o = byKey.get(f.key);
    return {
      stage: f.key,
      stageIdx: i,
      probability: o ? clamp01(o.probability) : 0,
      verdict: o?.verdict != null ? String(o.verdict) : null,
      verbatim: o?.verbatim != null ? String(o.verbatim) : null,
      detail:
        o?.detail && typeof o.detail === "object"
          ? (o.detail as Record<string, unknown>)
          : null,
    };
  });
}

// ---- Monte Carlo (pure, deterministic) -------------------------------------

/** mulberry32 — tiny deterministic PRNG; same seed → same trajectories. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type StageOutcome = {
  stage: string;
  /** Mean share of the panel reaching PAST this stage, over all iterations. */
  mean: number;
  /** 95% interval (2.5th / 97.5th percentile of per-iteration shares). */
  ci95: [number, number];
};

export type MonteCarloResult = {
  iterations: number;
  seed: number;
  panelSize: number;
  stages: StageOutcome[];
};

/**
 * Sample `iterations` full-panel trajectories over the persona-reported
 * conditional stage probabilities. Deterministic for a given seed. Each
 * iteration walks every persona through the funnel; a persona advances past
 * stage k iff it advanced past 0..k-1 and rng() < p_k.
 */
export function monteCarlo(
  panel: PersonaDecisions[],
  iterations = 1000,
  seed = 42,
): MonteCarloResult {
  const nStages = panel.length ? panel[0].decisions.length : 0;
  const stageKeys = panel.length ? panel[0].decisions.map((d) => d.stage) : [];
  const rng = mulberry32(seed);
  // counts[iter][stage] = personas advancing past stage
  const shares: number[][] = Array.from({ length: nStages }, () => []);
  for (let it = 0; it < iterations; it++) {
    const counts = new Array<number>(nStages).fill(0);
    for (const pd of panel) {
      let alive = true;
      for (let s = 0; s < nStages; s++) {
        if (!alive) break;
        alive = rng() < pd.decisions[s].probability;
        if (alive) counts[s] += 1;
      }
    }
    for (let s = 0; s < nStages; s++) {
      shares[s].push(panel.length ? counts[s] / panel.length : 0);
    }
  }
  const pct = (sorted: number[], q: number): number =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] : 0;
  return {
    iterations,
    seed,
    panelSize: panel.length,
    stages: stageKeys.map((key, s) => {
      const xs = [...shares[s]].sort((a, b) => a - b);
      const mean = xs.reduce((acc, v) => acc + v, 0) / (xs.length || 1);
      return { stage: key, mean, ci95: [pct(xs, 0.025), pct(xs, 0.975)] };
    }),
  };
}

// ---- Aggregation (pure) ----------------------------------------------------

export type VerdictSplit = { works: number; neutral: number; backfires: number; other: number };

export type AggregateReport = {
  panelSize: number;
  verdictSplits: Record<string, VerdictSplit>; // per stage
  /** Personas whose funnel died earliest, with where + why. */
  riskFlags: { persona: string; stage: string; probability: number; verbatim: string | null }[];
  topVerbatims: { persona: string; stage: string; verbatim: string }[];
};

function classifyVerdict(v: string | null): keyof VerdictSplit {
  const raw = (v ?? "").toLowerCase().trim();
  // Canonical single tokens from the decision prompt take precedence.
  if (raw === "works") return "works";
  if (raw === "neutral") return "neutral";
  if (raw === "backfires") return "backfires";
  // Free text (ingest path): strip negated phrases ("not manipulative",
  // "isn't gimmicky") so negation doesn't flip the classification.
  const s = raw.replace(/\b(?:not|isn't|isn t|never|no)\s+\w+/g, " ");
  if (/backfire|manipulat|gimmick|alienat|off-?putting|negative/.test(s)) return "backfires";
  if (/work|strong|moving|attractive|credible|positive|compelling/.test(s)) return "works";
  if (/neutral|mixed|indifferent|shrug/.test(s)) return "neutral";
  return raw ? "other" : "neutral";
}

export function aggregate(panel: PersonaDecisions[]): AggregateReport {
  const verdictSplits: Record<string, VerdictSplit> = {};
  const riskFlags: AggregateReport["riskFlags"] = [];
  const topVerbatims: AggregateReport["topVerbatims"] = [];
  for (const pd of panel) {
    for (const d of pd.decisions) {
      const split = (verdictSplits[d.stage] ??= { works: 0, neutral: 0, backfires: 0, other: 0 });
      split[classifyVerdict(d.verdict)] += 1;
      if (d.probability <= 0.25) {
        riskFlags.push({
          persona: pd.persona.name,
          stage: d.stage,
          probability: d.probability,
          verbatim: d.verbatim,
        });
      }
    }
    // One representative quote per persona: the last non-empty verbatim (the
    // deepest point they reached with something to say).
    const last = [...pd.decisions].reverse().find((d) => d.verbatim && d.verbatim.trim());
    if (last) topVerbatims.push({ persona: pd.persona.name, stage: last.stage, verbatim: last.verbatim! });
  }
  riskFlags.sort((a, b) => a.probability - b.probability);
  return {
    panelSize: panel.length,
    verdictSplits,
    riskFlags: riskFlags.slice(0, 12),
    topVerbatims: topVerbatims.slice(0, 16),
  };
}

// ---- Report rendering (pure) -----------------------------------------------

export function renderReportMd(input: {
  label: string;
  funnelKey: string;
  backend: string;
  panel: PersonaDecisions[];
  mc: MonteCarloResult;
  agg: AggregateReport;
  sourceNote?: string | null;
}): string {
  const funnel = FUNNELS[input.funnelKey] ?? [];
  const stageLabel = (key: string) => funnel.find((f) => f.key === key)?.label ?? key;
  const pctStr = (v: number) => `${Math.round(v * 100)}%`;
  const lines: string[] = [
    `# Panel-Sim — ${input.label}`,
    ``,
    `**Backend:** ${input.backend} · **Panel:** ${input.agg.panelSize} personas · **Funnel:** ${input.funnelKey} · **Monte Carlo:** ${input.mc.iterations} iterations (seed ${input.mc.seed})`,
    input.sourceNote ? `**Source:** ${input.sourceNote}` : ``,
    ``,
    `## Funnel outcomes (share of panel advancing past each stage)`,
    ``,
    `| Stage | Mean | 95% interval |`,
    `|-------|------|--------------|`,
    ...input.mc.stages.map(
      (s) => `| ${stageLabel(s.stage)} | ${pctStr(s.mean)} | ${pctStr(s.ci95[0])} – ${pctStr(s.ci95[1])} |`,
    ),
    ``,
    `## Verdict splits`,
    ``,
    `| Stage | Works | Neutral | Backfires | Other |`,
    `|-------|-------|---------|-----------|-------|`,
    ...Object.entries(input.agg.verdictSplits).map(
      ([stage, v]) => `| ${stageLabel(stage)} | ${v.works} | ${v.neutral} | ${v.backfires} | ${v.other} |`,
    ),
    ``,
    `## Risk flags (lowest-probability stage decisions)`,
    ``,
    ...(input.agg.riskFlags.length
      ? input.agg.riskFlags.map(
          (r) =>
            `- **${r.persona}** dies at ${stageLabel(r.stage)} (p=${pctStr(r.probability)})${r.verbatim ? ` — "${r.verbatim}"` : ""}`,
        )
      : [`- none`]),
    ``,
    `## Panel verbatims`,
    ``,
    ...input.agg.topVerbatims.map((v) => `> **${v.persona}** (${stageLabel(v.stage)}): "${v.verbatim}"`),
    ``,
    `---`,
    `*Advisory only. Filed as a Decision — a human makes the call.*`,
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

// ---- Legacy report ingest (pure) -------------------------------------------
//
// Seed path (spec "Seed fixture"): parse the 2026-07-26 16-persona health-
// officer panel report (authored by the main-session subagent run) into
// Persona + StageDecision rows. The report gives an explicit inbox-open
// probability per persona; deeper stages are narrative decisions ("opens the
// deck", "archives"), which we map to conservative probabilities via the
// DERIVED_ACTION_MAP below. Every derived value is flagged {derived:true} in
// detail so downstream consumers can tell measured-ish from mapped.

export type LegacyPersona = {
  idx: number;
  name: string;
  jurisdiction: string | null;
  profile: string;
  openProbability: number | null;
  readEmail: boolean;
  openedDeck: boolean;
  finalAction: string | null;
  internalThought: string | null;
};

const DERIVED_ACTION_MAP: [RegExp, number][] = [
  [/repl(y|ies) with questions|books? a call|reply.*high likelihood|forwards? to .*with recommendation/i, 0.8],
  [/replies|emails? back|calls?/i, 0.7],
  [/saves|flags|forwards|shares|keeps|bookmark/i, 0.35],
  [/maybe|might|on the fence|revisit/i, 0.2],
  [/nothing|archives|deletes|ignores|does not reply|no repl/i, 0.05],
];

export function derivedActionProbability(finalAction: string | null): number {
  if (!finalAction) return 0.05;
  for (const [re, p] of DERIVED_ACTION_MAP) {
    if (re.test(finalAction)) return p;
  }
  return 0.1;
}

export function parseLegacyPanelReport(md: string): LegacyPersona[] {
  const out: LegacyPersona[] = [];
  // Directory table rows: | 1 | Rosa Vargas | Passaic City NJ | profile... |
  const dir = new Map<number, { name: string; jurisdiction: string; profile: string }>();
  for (const m of md.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)) {
    dir.set(Number(m[1]), { name: m[2].trim(), jurisdiction: m[3].trim(), profile: m[4].trim() });
  }
  // Per-persona walkthrough sections.
  const sections = md.split(/^###\s+Persona\s+(\d+)\s+—\s+([^\n]+)$/m);
  // split() yields [pre, idx, title, body, idx, title, body, ...]
  for (let i = 1; i + 2 < sections.length; i += 3) {
    const idx = Number(sections[i]);
    const title = (sections[i + 1] ?? "").trim();
    const body = sections[i + 2] ?? "";
    const d = dir.get(idx);
    const nameFromTitle = title.replace(/\*+/g, "").trim();
    const open = body.match(/Open:\s*(?:Yes\s*)?\(?\s*(\d{1,3})\s*%\s*likelihood/i);
    const finalAction = body.match(/\*\*FINAL ACTION:?\*\*\s*([^\n]+)/i);
    const thought = body.match(/\*Internal thought:?\*\s*"?([^"\n]+)"?/i);
    const hasDeckSection = /\*\*DECK:?\*\*/i.test(body);
    const declinedDeck = /(does not|doesn't|never)\s+open(s)?\s+the\s+deck/i.test(body);
    out.push({
      idx,
      name: d?.name ?? nameFromTitle ?? `Persona ${idx}`,
      jurisdiction: d?.jurisdiction ?? null,
      profile: d?.profile ?? "",
      openProbability: open ? clamp01(Number(open[1])) : null,
      readEmail: /\*\*EMAIL:?\*\*/i.test(body),
      openedDeck: hasDeckSection && !declinedDeck,
      finalAction: finalAction ? finalAction[1].replace(/\*+/g, "").trim() : null,
      internalThought: thought ? thought[1].trim() : null,
    });
  }
  out.sort((a, b) => a.idx - b.idx);
  return out;
}

/**
 * Convert parsed legacy personas into the standard PersonaDecisions shape for
 * the 'coldemail-deck' funnel. Non-inbox stages are narrative-derived and
 * flagged as such.
 */
export function legacyToPanel(legacy: LegacyPersona[]): PersonaDecisions[] {
  return legacy.map((lp) => {
    const persona: Persona = {
      idx: lp.idx,
      name: lp.name,
      role: null,
      jurisdiction: lp.jurisdiction,
      profile: lp.profile,
      traits: {},
    };
    const derived = { derived: true, source: "narrative walkthrough, DERIVED_ACTION_MAP" };
    const decisions: StageDecision[] = [
      {
        stage: "inbox_open",
        stageIdx: 0,
        probability: lp.openProbability ?? 0.3,
        verdict: null,
        verbatim: null,
        detail: lp.openProbability == null ? derived : null,
      },
      {
        stage: "email_read",
        stageIdx: 1,
        probability: lp.readEmail ? 0.9 : 0.1,
        verdict: null,
        verbatim: null,
        detail: derived,
      },
      {
        stage: "deck_open",
        stageIdx: 2,
        probability: lp.openedDeck ? 0.9 : 0.1,
        verdict: null,
        verbatim: null,
        detail: derived,
      },
      {
        stage: "action",
        stageIdx: 3,
        probability: derivedActionProbability(lp.finalAction),
        verdict: lp.finalAction,
        verbatim: lp.internalThought,
        detail: derived,
      },
    ];
    return { persona, decisions };
  });
}
