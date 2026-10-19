// Section text formatting helpers (Item 1.4).
//
// The auto-draft orchestrator asks the model to lead each section with a single
// "## <Section>" heading followed by the body, then strips that heading before
// saving. The original stripper was `text.replace(/^##\s+.*$/m, "")` — two bugs:
//
//   1. The `m` (multiline) flag let `^` match the start of ANY line, so the
//      regex could delete a "## Subheading" deeper in the body instead of the
//      leading title — silently dropping a chunk of the section.
//   2. On run-on output (heading and first sentence on the same line) the greedy
//      `.*$` swallowed the body's opening sentence.
//
// Result: the first sentence of every section was being clipped. This version
// removes ONLY a heading that is literally the first line, can't span
// paragraphs, and never returns empty when there was input.

/**
 * Strip a single leading markdown heading line (e.g. "## Executive Summary")
 * from a generated section body, preserving every sentence of the body.
 */
export function stripSectionHeader(text: string): string {
  const original = text.trim();
  // Remove one leading ATX heading line. Anchored to the very start (no `m`
  // flag) so an in-body "## Subheading" survives, and line-bounded ([^\n]) so
  // it can never reach into the next paragraph.
  const stripped = original.replace(/^#{1,6}[ \t]+[^\n]*(?:\r?\n|$)/, "").trim();
  // Safety net: if that removed everything, the heading and body shared a single
  // line (run-on output). Don't clip the body — drop only the marker characters.
  if (!stripped && original) {
    return original.replace(/^#{1,6}[ \t]+/, "").trim();
  }
  return stripped;
}
