// Partner-facing copy sanitizer (Item 1.6, layer 2).
//
// WHY THIS EXISTS: two classes of internal text must never reach a surface a
// partner can see (a generated outreach email, an exported letter of
// commitment, a partner profile view):
//
//   1. DEAD-RELATIONSHIP NAMES — relationships that ended; naming them is a
//      live-relationship hazard ("OldPartnerCo", "Legacy Recovery Systems", etc.).
//   2. INTERNAL FRAMING — disparaging or strategy-internal phrasing that reads
//      fine in the operator's private workspace but is damaging if a partner sees
//      it ("Riverside will greenlight anything", "not a PG/debt scenario").
//
// These phrases are NOT stored in the codebase — they are generated at runtime
// (model output, auto-memory). The committed guardrails (lib/copilot-context.ts,
// lib/prompts.ts) only *instruct* the model to avoid them; nothing enforced it.
// This module is the enforcement: a single chokepoint every partner-facing emit
// boundary routes through, so the blocklist lives in exactly one extensible
// place. Pair it with the positive-form prompt rewrite (layer 1) and the edit
// affordance (layer 3) for defense in depth.

export type Redaction = {
  /** Human label for what rule fired (for logging / the edit UI). */
  rule: string;
  /** The exact substring that was matched and removed/replaced. */
  matched: string;
  /** What it was replaced with ("" = stripped). */
  replacedWith: string;
};

export type SanitizeResult = {
  /** The cleaned, partner-safe text. */
  clean: string;
  /** Everything that was stripped/replaced — surface this to the operator. */
  redactions: Redaction[];
  /** True when nothing had to be changed. */
  safe: boolean;
};

type Rule = {
  rule: string;
  pattern: RegExp; // MUST be global; flags are normalized in buildRules()
  replacement: string;
};

// Dead relationships — kept in sync with lib/prompts.ts / copilot-context.ts.
// Replaced with a neutral marker so the redaction is visible, never silently
// dropped mid-sentence into something misleading.
const DEAD_RELATIONSHIP_NAMES = [
  "OldPartnerCo",
  "Legacy Recovery Systems",
  "LRS",
  "Jane Barred",
  "banned.contact@example.org",
  "banned.contact2@example.org",
];

// Internal/disparaging framing. Order matters: longer, more specific phrases
// first so they win over their shorter substrings.
const INTERNAL_PHRASES: Array<{ rule: string; phrase: RegExp; replacement: string }> = [
  // The two phrases the brief calls out by name.
  { rule: "disparage-greenlight", phrase: /\b(?:Riverside\s+)?will\s+greenlight\s+anything\b/gi, replacement: "" },
  { rule: "disparage-greenlight", phrase: /\bgreenlight\s+anything\b/gi, replacement: "" },
  { rule: "internal-pg-debt", phrase: /\bnot\s+a\s+PG\/debt\s+scenario\b/gi, replacement: "" },
  // Extensible: any remaining "PG/debt" framing token.
  { rule: "internal-pg-debt", phrase: /\bPG\/debt\b/gi, replacement: "" },
];

function buildRules(): Rule[] {
  const rules: Rule[] = [];
  for (const name of DEAD_RELATIONSHIP_NAMES) {
    // Escape regex metacharacters in the literal name/email.
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rules.push({
      rule: "dead-relationship",
      // Word boundaries: without them the short acronym "LRS" redacted the
      // middle of "dollars"/"years" on every partner-facing surface (found
      // by the R2 pool-outreach tests, 2026-06-11).
      pattern: new RegExp(`\\b${esc}\\b`, "gi"),
      replacement: "[redacted]",
    });
  }
  for (const p of INTERNAL_PHRASES) {
    const flags = p.phrase.flags.includes("g") ? p.phrase.flags : p.phrase.flags + "g";
    rules.push({ rule: p.rule, pattern: new RegExp(p.phrase.source, flags), replacement: p.replacement });
  }
  return rules;
}

const RULES = buildRules();

/** Collapse the whitespace/punctuation artifacts left after a phrase is stripped. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ") // doubled spaces from a removed word
    .replace(/\s+([,.;:!?])/g, "$1") // space before punctuation
    .replace(/([,;:])\s*\1+/g, "$1") // doubled punctuation
    .replace(/\(\s*\)/g, "") // empty parens left by "(no ...)" removals
    .replace(/[ \t]+\n/g, "\n") // trailing spaces
    .replace(/\n{3,}/g, "\n\n"); // runaway blank lines
}

/**
 * Strip/replace every blocklisted phrase from text headed for a partner.
 * Returns the clean text plus an audit of what changed. Call this at EVERY
 * partner-facing emit boundary — generated emails, exports, profile renders.
 */
export function sanitizePartnerCopy(input: string | null | undefined): SanitizeResult {
  if (!input) return { clean: input ?? "", redactions: [], safe: true };
  let clean = input;
  const redactions: Redaction[] = [];
  for (const r of RULES) {
    clean = clean.replace(r.pattern, (match) => {
      redactions.push({ rule: r.rule, matched: match, replacedWith: r.replacement });
      return r.replacement;
    });
  }
  if (redactions.length) clean = tidy(clean);
  return { clean, redactions, safe: redactions.length === 0 };
}

/** True when text can be shown to a partner verbatim. */
export function isPartnerSafe(input: string | null | undefined): boolean {
  return sanitizePartnerCopy(input).safe;
}
