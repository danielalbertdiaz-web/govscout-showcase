// Item 2.1: pure transform from a data/blocks/*.md file to a seedable
// boilerplate block. No fs, no db — so title/category/needs_review derivation
// is unit-tested against fixture strings. The fs+db shell lives in
// lib/boilerplate.ts (seedBoilerplateFromDisk).

export type SeededBlockInput = {
  /** Stable key derived from the filename (drives idempotency). */
  key: string;
  title: string;
  bodyMarkdown: string;
  category: string;
  /** "needs_review" when the body still carries human-input placeholders. */
  status: "ready" | "needs_review";
  /** Short descriptor lifted from the file's intro line, if any. */
  notes: string | null;
};

export type RawBlockEntry = { filename: string; content: string };

// Files that are documentation about the library, not library content.
const SKIP_FILES = /^readme(\.md)?$/i;

// Human-input placeholders left in blocks ported from prior RFP submissions.
// Any match flags the block needs_review so it surfaces for completion rather
// than silently shipping a "[County]" / "[insert ...]" into a partner draft.
const PLACEHOLDER = /\[(?:\s*)(?:insert|research\s+flag|county|tbd|todo|verify|needs|placeholder|date|name|number)\b|\bTBD\b|\bTKTK\b|\[\s*\]|\[\.{3}\]/i;

// Category derivation by filename slug keyword. Order matters — first match
// wins, so more specific patterns precede general ones.
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/bio\b|reed|doe/, "personnel"],
  [/indirect|rate|budget|financ|fringe|overhead/, "financials"],
  [/partner|roster/, "partners"],
  [/pilot|capacity|toxicolog|glp1|mat\b|casepath|ems|veterans/, "programs"],
  [/citation|reference|matrix|library|bibliograph/, "reference"],
  [/pillar|method|framing|architecture|knee|sherrill/, "narrative"],
  [/org|overview|capability|background/, "organization"],
];

/** `01-org-overview.md` -> `org-overview`. Strips numeric prefix + extension. */
export function slugFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_]/, "")
    .trim()
    .toLowerCase();
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function deriveCategory(slug: string): string {
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(slug)) return cat;
  }
  return "general";
}

/** Transform one markdown file into a seedable block. Pure. */
export function deriveBlockFromFile(filename: string, content: string): SeededBlockInput {
  const slug = slugFromFilename(filename);
  const body = content.trim();
  const lines = body.split("\n");

  // Title: first `# H1`, else title-cased slug.
  let title = titleCase(slug);
  let notes: string | null = null;
  let firstHeadingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      title = m[1].trim();
      firstHeadingIdx = i;
      break;
    }
  }
  // Notes: first non-empty, non-heading, non-rule line after the title — the
  // "Drop-in language for ..." descriptor these files open with.
  for (let i = firstHeadingIdx + 1; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s === "---" || s.startsWith("#")) continue;
    notes = s.length > 240 ? `${s.slice(0, 237)}…` : s;
    break;
  }

  return {
    key: slug,
    title,
    bodyMarkdown: body,
    category: deriveCategory(slug),
    status: PLACEHOLDER.test(body) ? "needs_review" : "ready",
    notes,
  };
}

/** Map a set of raw files to seedable blocks, skipping README/docs. Pure. */
export function parseBlockEntries(entries: RawBlockEntry[]): SeededBlockInput[] {
  return entries
    .filter((e) => !SKIP_FILES.test(e.filename) && /\.md$/i.test(e.filename))
    .filter((e) => e.content.trim().length > 0)
    .map((e) => deriveBlockFromFile(e.filename, e.content));
}
