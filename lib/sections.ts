export type SectionKey =
  | "executive_summary"
  | "capability_statement"
  | "technical_approach"
  | "past_performance"
  | "reviewer_notes";

export const SECTIONS: { key: SectionKey; title: string; description: string }[] = [
  {
    key: "executive_summary",
    title: "Executive Summary",
    description: "1–2 page narrative pitch: who we are, why this opportunity, what we'll deliver, headline outcomes.",
  },
  {
    key: "capability_statement",
    title: "Capability Statement",
    description: "Core competencies, differentiators, certifications, NAICS codes, and past-performance highlights.",
  },
  {
    key: "technical_approach",
    title: "Technical Approach",
    description: "Methodology, work plan, milestones, and how each capability block maps to the scope of work.",
  },
  {
    key: "past_performance",
    title: "Past Performance",
    description: "Relevant prior contracts, dollar values, periods of performance, references, and outcomes.",
  },
  {
    key: "reviewer_notes",
    title: "Reviewer Notes",
    description: "Internal QA: gaps, [TBD] items, evaluation-criteria coverage, and recommended capability blocks to add.",
  },
];

export const SECTION_KEYS: SectionKey[] = SECTIONS.map((s) => s.key);

export function sectionTitle(key: SectionKey): string {
  return SECTIONS.find((s) => s.key === key)?.title ?? key;
}

export type SectionMap = Record<SectionKey, string>;

export function emptySections(): SectionMap {
  return {
    executive_summary: "",
    capability_statement: "",
    technical_approach: "",
    past_performance: "",
    reviewer_notes: "",
  };
}

export function splitFullDraft(full: string): SectionMap {
  const out = emptySections();
  if (!full.trim()) return out;
  const headings = SECTIONS.map((s) => ({ key: s.key, re: new RegExp(`^##\\s+${escapeRe(s.title)}\\s*$`, "im") }));
  const positions: { key: SectionKey; index: number; matchLen: number }[] = [];
  for (const h of headings) {
    const m = h.re.exec(full);
    if (m && typeof m.index === "number") {
      positions.push({ key: h.key, index: m.index, matchLen: m[0].length });
    }
  }
  positions.sort((a, b) => a.index - b.index);
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const next = positions[i + 1];
    const start = cur.index + cur.matchLen;
    const end = next ? next.index : full.length;
    out[cur.key] = full.slice(start, end).replace(/^---+\s*$/gm, "").trim();
  }
  if (!positions.length) {
    out.executive_summary = full.trim();
  }
  return out;
}

export function joinSections(s: SectionMap): string {
  const order: SectionKey[] = ["executive_summary", "capability_statement", "technical_approach", "past_performance"];
  const parts: string[] = [];
  for (const key of order) {
    if (!s[key]?.trim()) continue;
    parts.push(`## ${sectionTitle(key)}\n\n${s[key].trim()}`);
  }
  if (s.reviewer_notes?.trim()) {
    parts.push(`---\n\n## Reviewer Notes\n\n${s.reviewer_notes.trim()}`);
  }
  return parts.join("\n\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}
