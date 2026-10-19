// Native PanelBackend — the thin impure shell that drives the local `claude`
// CLI (same transport as the rest of v5: lib/claude-cli.ts, Max-plan OAuth,
// NO metered API). Sonnet for personas and per-persona funnel walks (cheap,
// N=12–24 calls total); the pure core does everything else.
//
// This is the first implementation behind the PanelBackend seam. When
// MiroFish lands it becomes the second (see lib/simulation.ts) and callers
// don't change.

import { runClaude } from "./claude-cli";
import {
  FUNNELS,
  buildDecisionPrompt,
  buildPersonaSetPrompt,
  parsePersonaSet,
  parseStageDecisions,
  type PanelBackend,
  type PanelRunInput,
  type Persona,
  type PersonaDecisions,
} from "./panel-sim";

export const PANEL_MODEL_PERSONAS =
  process.env.PANEL_SIM_MODEL || "claude-sonnet-4-6";

const PERSONA_SYSTEM =
  "You are a demographic simulation engine building audience panels for message testing. You output only strict JSON. You never add prose, preamble, or markdown fences.";

const DECISION_SYSTEM =
  "You are a persona simulation engine for audience reaction testing. You stay rigorously in character, including negative, dismissive, and hostile reactions when the persona would have them. You output only strict JSON. No prose, no markdown fences.";

export class NativePanelBackend implements PanelBackend {
  id = "native";

  constructor(
    private opts: {
      model?: string;
      /** Progress hook for the CLI runner's log lines. */
      onProgress?: (msg: string) => void;
    } = {},
  ) {}

  private model(): string {
    return this.opts.model || PANEL_MODEL_PERSONAS;
  }

  private progress(msg: string): void {
    this.opts.onProgress?.(msg);
  }

  async buildPersonas(spec: string, n: number): Promise<Persona[]> {
    this.progress(`Generating ${n} personas (${this.model()})…`);
    const { text } = await runClaude({
      model: this.model(),
      systemPrompt: PERSONA_SYSTEM,
      userPrompt: buildPersonaSetPrompt(spec, n),
      maxTokens: 8192,
    });
    const personas = parsePersonaSet(text, n);
    if (personas.length === 0) {
      throw new Error(`persona generation returned no parseable personas (got: ${text.slice(0, 200)})`);
    }
    if (personas.length < n) {
      this.progress(`Warning: asked for ${n} personas, parsed ${personas.length}. Continuing with ${personas.length}.`);
    }
    return personas;
  }

  async runPanel(input: PanelRunInput): Promise<PersonaDecisions[]> {
    const funnel = FUNNELS[input.funnelKey];
    if (!funnel) throw new Error(`unknown funnel "${input.funnelKey}"`);
    const personas = await this.buildPersonas(input.panelSpec, input.n);
    const out: PersonaDecisions[] = [];
    // Sequential on purpose: N=12–24 Sonnet calls on the shared Max-plan CLI;
    // parallel spawns would just contend for the same session budget.
    for (const persona of personas) {
      this.progress(`Persona ${persona.idx}/${personas.length}: ${persona.name} walking the funnel…`);
      const { text } = await runClaude({
        model: this.model(),
        systemPrompt: DECISION_SYSTEM,
        userPrompt: buildDecisionPrompt(persona, input.artifacts, funnel),
        maxTokens: 4096,
      });
      out.push({ persona, decisions: parseStageDecisions(text, funnel) });
    }
    return out;
  }
}
