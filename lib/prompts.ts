import { SECTIONS, sectionTitle, type SectionKey, type SectionMap } from "./sections";

export const SYSTEM_PROMPT = `You are GovScout AI, a senior federal-grant proposal writer assisting Acme Consulting Group LLC and its NJ Thrive Initiative consortium.

VOICE & STYLE
- Federal grant-narrative voice: precise, evidence-anchored, no marketing fluff.
- Use plain English. Short paragraphs. Active voice. No em-dashes longer than necessary.
- Never invent numbers, dates, partners, or citations. If a number is missing, write [TBD: <what is needed>] and continue.
- Never use the names: OldPartnerCo, Legacy Recovery Systems, LRS, Jane Barred, banned.contact@example.org, banned.contact2@example.org. These are dead relationships and must not appear anywhere.
- "Brightline" is referenced as just "Brightline" (not "Brightline Creative" or "Brightline America"). Do not use phrases like "PG", "debt vehicle", or any debt/private-guarantee framing for Brightline.
- Dr. Reed's full canonical name is "Taylor Paul Reed, PhD, MPH".
- Example Tech LLC and Dr. Taylor Reed LLC are joint IP holdcos for CasePath — never imply other ownership.
- Do NOT reference DOJ BJA grants — that lane is decommissioned.

OUTPUT FORMAT
- Output four sections in this order, each as a level-2 markdown heading:
  ## Executive Summary
  ## Capability Statement
  ## Technical Approach
  ## Past Performance
- Each section should be 250–600 words unless the user requests otherwise.
- Anchor every factual claim back to the capability blocks the user attached. If a claim cannot be supported, mark it [TBD: ...].
- Close with a short \`---\` divider followed by a "## Reviewer Notes" block listing: (a) gaps the human writer must fill, (b) any [TBD] items, and (c) recommended next blocks to load.
`;

export function buildUserPrompt(input: {
  business: string;
  naics: string;
  opportunity: string;
  blocks: { id: string; title: string; body: string }[];
}) {
  const blockText = input.blocks
    .map((b) => `### Block ${b.id} — ${b.title}\n\n${b.body.trim()}`)
    .join("\n\n---\n\n");
  const blocksHeader = input.blocks.length
    ? `# CAPABILITY BLOCKS (use as the source of truth)\n\n${blockText}`
    : "# CAPABILITY BLOCKS\n\n(none provided — write narrative-only and flag [TBD] for facts you cannot source)";

  return `${blocksHeader}

# BUSINESS PROFILE
${input.business.trim() || "(not provided)"}

# NAICS CODES
${input.naics.trim() || "(not provided)"}

# TARGET OPPORTUNITY (NOFO / RFP / solicitation)
${input.opportunity.trim() || "(not provided)"}

# TASK
Draft the four required proposal sections (Executive Summary, Capability Statement, Technical Approach, Past Performance) for this opportunity, using ONLY facts grounded in the capability blocks above plus the business profile. Mark anything you cannot verify with [TBD]. Close with a Reviewer Notes section.`;
}

export const SECTION_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

SECTION-SCOPED OUTPUT MODE
- You will be asked to write or rewrite a SINGLE proposal section.
- Output ONLY that section. Start with a level-2 markdown heading exactly matching the requested section title (e.g., "## Technical Approach").
- Do not include any other section headings, do not include the \`---\` divider, do not include Reviewer Notes unless the requested section IS Reviewer Notes.
- Stay within 250–600 words unless the per-section instruction overrides.`;

export function buildSectionPrompt(input: {
  business: string;
  naics: string;
  opportunity: string;
  blocks: { id: string; title: string; body: string }[];
  section: SectionKey;
  instruction?: string;
  otherSections?: Partial<SectionMap>;
  partnersBlock?: string;
  warmContactsBlock?: string;
}): string {
  const blockText = input.blocks
    .map((b) => `### Block ${b.id} — ${b.title}\n\n${b.body.trim()}`)
    .join("\n\n---\n\n");
  const blocksHeader = input.blocks.length
    ? `# CAPABILITY BLOCKS (use as the source of truth)\n\n${blockText}`
    : "# CAPABILITY BLOCKS\n\n(none provided — write narrative-only and flag [TBD] for facts you cannot source)";
  const partnersHeader = input.partnersBlock?.trim() ? `\n\n${input.partnersBlock.trim()}` : "";
  const warmHeader = input.warmContactsBlock?.trim() ? `\n\n${input.warmContactsBlock.trim()}` : "";

  const otherText = input.otherSections
    ? SECTIONS.filter((s) => s.key !== input.section)
        .map((s) => {
          const text = input.otherSections?.[s.key]?.trim();
          return text ? `### ${s.title}\n\n${text}` : null;
        })
        .filter(Boolean)
        .join("\n\n---\n\n")
    : "";

  const otherBlock = otherText
    ? `\n\n# EXISTING DRAFT — OTHER SECTIONS (for context only; do not reproduce or revise them)\n\n${otherText}`
    : "";

  const instructionBlock = input.instruction?.trim()
    ? `\n\n# PER-SECTION INSTRUCTION FROM THE WRITER\n${input.instruction.trim()}`
    : "";

  const target = sectionTitle(input.section);

  return `${blocksHeader}${partnersHeader}${warmHeader}

# BUSINESS PROFILE
${input.business.trim() || "(not provided)"}

# NAICS CODES
${input.naics.trim() || "(not provided)"}

# TARGET OPPORTUNITY (NOFO / RFP / solicitation)
${input.opportunity.trim() || "(not provided)"}${otherBlock}${instructionBlock}

# TASK
Rewrite ONLY the "${target}" section for this proposal. Output a single \`## ${target}\` heading followed by the section body. Do not output any other section. Anchor every factual claim to the capability blocks above; mark unverifiable items [TBD: ...].`;
}
