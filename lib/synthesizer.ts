// Item 2.3: RFP Synthesizer (pure core).
//
// Given a loaded NOFO (ExtractedNofo), this module decides WHICH response
// sections to write and builds a per-section "mini-prompt" keyed to that
// solicitation's demanded tone + its stated evaluation criteria. It reuses the
// existing draft engine (claude-cli/streamClaude) — nothing here calls a model
// or touches the filesystem, so the enumeration + prompt logic is unit-testable
// in isolation. The thin API shell (app/api/drafts/[id]/synthesize) runs each
// prompt, sanitizes the output through the 1.6 guardrail, and stores it as a
// Working-Draft block (Item 2.2).
//
// NOTE: an earlier session left a stub here written against ExtractedNofo fields
// that do not exist in lib/extract.ts (keywords, focus_area, estimated_funding,
// application_due, an object-array evaluation_criteria). This rewrite is aligned
// to the REAL ExtractedNofo shape.

import { SYSTEM_PROMPT } from "./prompts";
import { SECTIONS } from "./sections";
import type { ExtractedNofo } from "./extract";

export type SynthSection = {
  /** The funder's exact section title, e.g. "Project Narrative". */
  title: string;
  /** Stable, filename-safe slug used as the working-draft sourceRef. */
  slug: string;
};

/** Fallback set when a NOFO declares no explicit required_sections. */
const DEFAULT_SECTION_TITLES = SECTIONS.filter((s) => s.key !== "reviewer_notes").map(
  (s) => s.title,
);

export function slugifySection(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Enumerate the response sections to synthesize for a NOFO. Pulls from the
 * funder's own `required_sections` when present (trimmed, de-duped by slug,
 * empties dropped); otherwise falls back to the four standard proposal
 * sections so the synthesizer still produces a usable skeleton.
 */
export function enumerateSynthesisSections(nofo: ExtractedNofo | null | undefined): SynthSection[] {
  const raw = nofo?.required_sections?.length ? nofo.required_sections : DEFAULT_SECTION_TITLES;
  const seen = new Set<string>();
  const out: SynthSection[] = [];
  for (const entry of raw) {
    const title = String(entry ?? "").trim();
    if (!title) continue;
    const slug = slugifySection(title);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ title, slug });
  }
  // Guard against a NOFO whose section titles all slug to nothing.
  if (!out.length) {
    for (const title of DEFAULT_SECTION_TITLES) {
      out.push({ title, slug: slugifySection(title) });
    }
  }
  return out;
}

/**
 * A compact description of the funder's voice/register, assembled from the
 * structured NOFO fields, so the model can match the *style the RFP demands*
 * rather than a generic house voice.
 */
export function describeNofoVoice(nofo: ExtractedNofo | null | undefined): string {
  const parts: string[] = [];
  if (nofo?.agency) parts.push(`Funder/agency: ${nofo.agency}`);
  if (nofo?.program) parts.push(`Program: ${nofo.program}`);
  if (nofo?.summary) parts.push(`What the funder is buying: ${nofo.summary}`);
  if (nofo?.page_limits) parts.push(`Page/length limits: ${nofo.page_limits}`);
  if (!parts.length) return "(no structured NOFO signal — infer a neutral, formal federal-grant register)";
  return parts.join("\n");
}

export const SYNTHESIS_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

RFP-SYNTHESIS MODE
- You are writing ONE required response section for a specific solicitation.
- MATCH THE FUNDER'S DEMANDED REGISTER: mirror the tone, formality, and emphasis the solicitation itself uses. A clinical/federal NOFO reads differently from a community-foundation RFP — write to the one in front of you.
- ADDRESS THE EVALUATION CRITERIA EXPLICITLY: structure the section so a reviewer scoring against the stated criteria can find each point. Where a criterion carries weight, give it proportional space.
- Output ONLY this one section. Begin with a single level-2 markdown heading exactly matching the requested section title (e.g., "## Project Narrative"). No other section headings; no \`---\` divider; no Reviewer Notes.
- PARTNER ATTRIBUTION: when consortium partners contribute to this section, give EACH partner its OWN clearly separated "### <Partner Name>" subsection describing that partner's specific contribution. Never blend two partners' contributions into one ambiguous paragraph, and never attribute a capability to a partner whose reference profile does not state it.
- Anchor every factual claim to the capability blocks / partner profiles provided. Mark anything unverifiable [TBD: ...]. Never invent numbers, dates, certifications, or past performance.`;

export function buildSynthesisSectionPrompt(input: {
  sectionTitle: string;
  nofo: ExtractedNofo | null | undefined;
  business: string;
  naics: string;
  opportunityText: string;
  blocks: { id: string; title: string; body: string }[];
  partnersBlock?: string;
}): string {
  const blockText = input.blocks
    .map((b) => `### Block ${b.id} — ${b.title}\n\n${b.body.trim()}`)
    .join("\n\n---\n\n");
  const blocksHeader = input.blocks.length
    ? `# CAPABILITY BLOCKS (source of truth)\n\n${blockText}`
    : "# CAPABILITY BLOCKS\n\n(none attached — write narrative-only and flag [TBD] for any fact you cannot source)";
  const partnersHeader = input.partnersBlock?.trim() ? `\n\n${input.partnersBlock.trim()}` : "";

  const criteria = input.nofo?.evaluation_criteria?.trim();
  const criteriaBlock = criteria
    ? `\n\n# EVALUATION CRITERIA (write so a reviewer scoring against these can find each point; respect any point weights)\n${criteria}`
    : "\n\n# EVALUATION CRITERIA\n(none stated — emphasize impact, feasibility, and organizational capacity)";

  return `${blocksHeader}${partnersHeader}

# SOLICITATION VOICE & CONTEXT (match this register)
${describeNofoVoice(input.nofo)}

# BUSINESS PROFILE
${input.business.trim() || "(not provided)"}

# NAICS CODES
${input.naics.trim() || "(not provided)"}

# TARGET OPPORTUNITY (NOFO / RFP / solicitation)
${input.opportunityText.trim() || "(not provided)"}${criteriaBlock}

# TASK
Write the "${input.sectionTitle}" response section for this solicitation. Output a single \`## ${input.sectionTitle}\` heading followed by the section body, in the funder's demanded tone, explicitly addressing the evaluation criteria above. Give each contributing partner its own \`### <Partner Name>\` subsection. Anchor every claim to the capability blocks / partner profiles; mark unverifiable items [TBD: ...].`;
}
